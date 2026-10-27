import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { Errors } from '../common/errors';
import { pageParams, parse, UserId } from '../common/http';
import { SafetyModule } from '../safety/safety.module';
import { StorageService } from '../storage/storage.service';
import { AssetsService } from './assets.service';
import { FoldersService } from './folders.service';
import { MAX_UPLOAD_BYTES, UPLOAD_MIMES, UploadsService } from './uploads.service';

const ListQuery = z.object({
  kind: z.enum(['image', 'video', 'text', 'audio']).optional(),
  favorite: z.enum(['true', 'false']).optional(),
  q: z.string().max(100).optional(),
  folder: z.string().max(64).optional(),
});
const FolderName = z.object({ name: z.string().trim().min(1, '请输入文件夹名称').max(20) }).strict();
const MoveBody = z.object({ ids: z.array(z.string().max(64)).min(1).max(100), folder_id: z.string().max(64).nullable() }).strict();
const PatchBody = z.object({ favorite: z.boolean().optional(), title: z.string().trim().min(1).max(60).optional() }).strict();
const UploadBody = z.object({
  filename: z.string().trim().min(1).max(120),
  mime: z.enum(UPLOAD_MIMES as [string, ...string[]], { message: '仅支持 PNG、JPEG、WebP 图片' }),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES, '单个文件不能超过 20 MB'),
});

@Controller()
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /** 第 1 步：创建上传会话，返回签名上传地址 */
  @Post('assets/uploads')
  @UseGuards(AuthGuard)
  create(@UserId() userId: string, @Body() body: unknown) {
    const b = parse(UploadBody, body);
    return this.uploads.create(userId, { filename: b.filename, mime: b.mime as (typeof UPLOAD_MIMES)[number], size: b.size });
  }

  /** 第 2 步：PUT 原始文件（以签名鉴权，与对象存储直传一致） */
  @Put('uploads/:id')
  @HttpCode(204)
  async receive(@Param('id') id: string, @Query('exp') exp: string, @Query('sig') sig: string, @Req() req: Request) {
    await this.uploads.receive(id, exp, sig, req);
  }

  /** 第 3 步：完成上传，审核通过后生成资产 */
  @Post('assets/uploads/:id/complete')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  complete(@UserId() userId: string, @Param('id') id: string) {
    return this.uploads.complete(userId, id);
  }
}

@Controller('assets')
@UseGuards(AuthGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  list(@UserId() userId: string, @Query() query: Record<string, unknown>) {
    const f = parse(ListQuery, { kind: query.kind, favorite: query.favorite, q: query.q, folder: query.folder });
    return this.assets.list(userId, { kind: f.kind, favorite: f.favorite ? f.favorite === 'true' : undefined, q: f.q, folder: f.folder, ...pageParams(query) });
  }

  /** 批量移动到文件夹；folder_id 为 null 时移出文件夹 */
  @Post('move')
  @HttpCode(200)
  async move(@UserId() userId: string, @Body() body: unknown) {
    const b = parse(MoveBody, body);
    return { moved: await this.assets.move(userId, b.ids, b.folder_id) };
  }

  @Get(':id/download')
  download(@UserId() userId: string, @Param('id') id: string) {
    return this.assets.download(userId, id);
  }

  @Get(':id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.assets.get(userId, id);
  }

  @Patch(':id')
  update(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.assets.update(userId, id, parse(PatchBody, body));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@UserId() userId: string, @Param('id') id: string) {
    return this.assets.remove(userId, id);
  }
}

@Controller('asset-folders')
@UseGuards(AuthGuard)
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  list(@UserId() userId: string) {
    return this.folders.list(userId);
  }

  @Post()
  create(@UserId() userId: string, @Body() body: unknown) {
    return this.folders.create(userId, parse(FolderName, body).name);
  }

  @Patch(':id')
  @HttpCode(204)
  rename(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.folders.rename(userId, id, parse(FolderName, body).name);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@UserId() userId: string, @Param('id') id: string) {
    return this.folders.remove(userId, id);
  }
}

/** 签名文件访问：校验签名与有效期后输出文件；带 dl 参数时以附件形式下载 */
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Get(':token')
  serve(@Param('token') token: string, @Query('exp') exp: string, @Query('sig') sig: string, @Query('dl') dl: string | undefined, @Res() res: Response) {
    const file = this.storage.open(token, exp, sig, typeof dl === 'string' ? dl : undefined);
    if (!file) throw Errors.notFound('文件');
    if (file.filename) {
      const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    }
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', `private, max-age=${Math.max(0, file.maxAge)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 文件以独立沙箱渲染，即使是 SVG 也无法执行脚本
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    file.stream.pipe(res);
  }
}

@Module({
  imports: [SafetyModule],
  controllers: [UploadsController, AssetsController, FoldersController, FilesController],
  providers: [AssetsService, UploadsService, FoldersService],
  exports: [AssetsService],
})
export class AssetsModule {}
