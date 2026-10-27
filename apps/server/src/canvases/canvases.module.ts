import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
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
}

@Module({
  imports: [AssetsModule],
  controllers: [CanvasesController],
  providers: [CanvasesService],
})
export class CanvasesModule {}
