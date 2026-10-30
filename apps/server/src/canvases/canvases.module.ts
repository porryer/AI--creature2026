import { Body, Controller, Delete, Get, Header, HttpCode, Module, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AssetsModule } from '../assets/assets.module';
import { AuthGuard } from '../auth/auth.guard';
import { Errors } from '../common/errors';
import { parse, UserId } from '../common/http';
import { CanvasesService } from './canvases.service';

const Name = z.string().trim().min(1, '请输入名称').max(60);
const CreateBody = z.object({ name: Name, doc: z.unknown().optional() });
const RenameBody = z.object({ name: Name }).strict();
const SaveBody = z.object({ doc: z.unknown(), version: z.number().int().min(1), name: Name.optional() }).strict();
const SnapshotBody = z.object({ label: z.string().trim().max(40).default('') }).strict();
const RestoreBody = z.object({ version: z.number().int().min(1) }).strict();
const ShareBody = z.object({ show_prompts: z.boolean().default(false) }).strict();

@Controller()
@UseGuards(AuthGuard)
export class CanvasesController {
  constructor(private readonly canvases: CanvasesService) {}

  @Get('projects')
  list(@UserId() userId: string) {
    return this.canvases.listProjects(userId);
  }

  /** 新建项目（附带一个画布），返回该画布 */
  @Post('projects')
  create(@UserId() userId: string, @Body() body: unknown) {
    const b = parse(CreateBody, body);
    return this.canvases.createProject(userId, b.name, b.doc);
  }

  @Patch('projects/:id')
  @HttpCode(204)
  rename(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.canvases.renameProject(userId, id, parse(RenameBody, body).name);
  }

  @Delete('projects/:id')
  @HttpCode(204)
  remove(@UserId() userId: string, @Param('id') id: string) {
    return this.canvases.deleteProject(userId, id);
  }

  @Get('canvases/latest')
  async latest(@UserId() userId: string) {
    const c = await this.canvases.latest(userId);
    if (!c) throw Errors.notFound('画布');
    return c;
  }

  @Get('canvases/:id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.canvases.get(userId, id);
  }

  @Put('canvases/:id')
  save(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.canvases.save(userId, id, parse(SaveBody, body));
  }

  @Get('canvases/:id/snapshots')
  snapshots(@UserId() userId: string, @Param('id') id: string) {
    return this.canvases.listSnapshots(userId, id);
  }

  @Post('canvases/:id/snapshots')
  snapshot(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.canvases.createSnapshot(userId, id, parse(SnapshotBody, body ?? {}).label);
  }

  @Get('canvases/:id/snapshots/:sid')
  getSnapshot(@UserId() userId: string, @Param('id') id: string, @Param('sid') sid: string) {
    return this.canvases.getSnapshot(userId, id, sid);
  }

  /** 恢复到历史版本，返回恢复后的画布 */
  @Post('canvases/:id/snapshots/:sid/restore')
  @HttpCode(200)
  restore(@UserId() userId: string, @Param('id') id: string, @Param('sid') sid: string, @Body() body: unknown) {
    return this.canvases.restore(userId, id, sid, parse(RestoreBody, body).version);
  }

  @Get('canvases/:id/share')
  async getShare(@UserId() userId: string, @Param('id') id: string) {
    return { share: await this.canvases.getShare(userId, id) };
  }

  @Put('canvases/:id/share')
  share(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.canvases.share(userId, id, parse(ShareBody, body ?? {}).show_prompts);
  }

  @Delete('canvases/:id/share')
  @HttpCode(204)
  unshare(@UserId() userId: string, @Param('id') id: string) {
    return this.canvases.unshare(userId, id);
  }
}

/** 分享页：无需登录，凭链接中的令牌只读查看 */
@Controller('shared')
export class SharedController {
  constructor(private readonly canvases: CanvasesService) {}

  @Get('canvases/:token')
  @Header('cache-control', 'no-store')
  @Header('x-robots-tag', 'noindex')
  canvas(@Param('token') token: string) {
    return this.canvases.shared(token);
  }
}

@Module({
  imports: [AssetsModule],
  controllers: [CanvasesController, SharedController],
  providers: [CanvasesService],
})
export class CanvasesModule {}
