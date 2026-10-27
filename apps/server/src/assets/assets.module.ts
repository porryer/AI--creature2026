import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { Errors } from '../common/errors';
import { pageParams, parse, UserId } from '../common/http';
import { StorageService } from '../storage/storage.service';
import { AssetsService } from './assets.service';

const ListQuery = z.object({
  kind: z.enum(['image', 'video', 'text', 'audio']).optional(),
  favorite: z.enum(['true', 'false']).optional(),
  q: z.string().max(100).optional(),
});
const PatchBody = z.object({ favorite: z.boolean().optional(), title: z.string().trim().min(1).max(60).optional() }).strict();

@Controller('assets')
@UseGuards(AuthGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  list(@UserId() userId: string, @Query() query: Record<string, unknown>) {
    const f = parse(ListQuery, { kind: query.kind, favorite: query.favorite, q: query.q });
    return this.assets.list(userId, { kind: f.kind, favorite: f.favorite ? f.favorite === 'true' : undefined, q: f.q, ...pageParams(query) });
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

/** 签名文件访问：校验签名与有效期后输出文件 */
@Controller('files')
export class FilesController {
  constructor(private readonly storage: StorageService) {}

  @Get(':token')
  serve(@Param('token') token: string, @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    const file = this.storage.open(token, exp, sig);
    if (!file) throw Errors.notFound('文件');
    res.setHeader('Content-Type', file.mime);
    res.setHeader('Cache-Control', `private, max-age=${Math.max(0, file.maxAge)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 文件以独立沙箱渲染，即使是 SVG 也无法执行脚本
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    file.stream.pipe(res);
  }
}

@Module({
  controllers: [AssetsController, FilesController],
  providers: [AssetsService],
  exports: [AssetsService],
})
export class AssetsModule {}
