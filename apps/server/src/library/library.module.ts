import { Body, Controller, Delete, Get, HttpCode, Module, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { LIBRARY_LIMITS } from '@creature/shared';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { parse, UserId } from '../common/http';
import { SafetyModule } from '../safety/safety.module';
import { LibraryService } from './library.service';

const Name = z.string().trim().min(1, '请输入名称').max(20, '名称最多 20 个字');
const Ref = z.object({ asset_id: z.string().min(1).max(64), view: z.enum(['front', 'side', 'back', 'full_body', 'expression']).nullable().optional() }).strict();
const CharacterBody = z
  .object({
    name: Name,
    description: z.string().trim().max(200, '描述最多 200 个字').default(''),
    likeness: z.enum(['none', 'self', 'authorized']),
    consent_asset_id: z.string().min(1).max(64).nullable().optional(),
    refs: z.array(Ref).max(LIBRARY_LIMITS.characterRefs.max),
  })
  .strict();
// 不能直接用 partial()：字段上的默认值在省略时仍会生效，会把未修改的描述清空
const CharacterPatch = CharacterBody.extend({ description: CharacterBody.shape.description.removeDefault() }).partial().strict();

const Tag = z.string().trim().min(1).max(20);
const BrandBody = z
  .object({
    name: Name,
    tone: z.string().trim().max(200, '调性描述最多 200 个字').default(''),
    colors: z
      .array(z.object({ name: z.string().trim().min(1).max(10), hex: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色格式为 #RRGGBB') }).strict())
      .max(LIBRARY_LIMITS.brandColors, `标准色最多 ${LIBRARY_LIMITS.brandColors} 个`)
      .default([]),
    fonts: z.array(Tag).max(LIBRARY_LIMITS.brandFonts, `字体最多 ${LIBRARY_LIMITS.brandFonts} 个`).default([]),
    banned: z.array(Tag).max(LIBRARY_LIMITS.brandBanned, `禁用元素最多 ${LIBRARY_LIMITS.brandBanned} 个`).default([]),
    logos: z
      .array(z.object({ asset_id: z.string().min(1).max(64), variant: z.enum(['primary', 'light', 'dark', 'mono']) }).strict())
      .max(LIBRARY_LIMITS.brandLogos, `Logo 最多 ${LIBRARY_LIMITS.brandLogos} 个版本`)
      .default([]),
  })
  .strict();
const BrandPatch = z
  .object({
    name: Name,
    tone: BrandBody.shape.tone.removeDefault(),
    colors: BrandBody.shape.colors.removeDefault(),
    fonts: BrandBody.shape.fonts.removeDefault(),
    banned: BrandBody.shape.banned.removeDefault(),
    logos: BrandBody.shape.logos.removeDefault(),
  })
  .partial()
  .strict();

@Controller('characters')
@UseGuards(AuthGuard)
export class CharactersController {
  constructor(private readonly library: LibraryService) {}

  @Get()
  list(@UserId() userId: string) {
    return this.library.listCharacters(userId);
  }

  @Post()
  create(@UserId() userId: string, @Body() body: unknown) {
    return this.library.createCharacter(userId, parse(CharacterBody, body));
  }

  @Get(':id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.library.getCharacter(userId, id);
  }

  @Patch(':id')
  update(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.library.updateCharacter(userId, id, parse(CharacterPatch, body));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@UserId() userId: string, @Param('id') id: string) {
    return this.library.removeCharacter(userId, id);
  }
}

@Controller('brand-kits')
@UseGuards(AuthGuard)
export class BrandKitsController {
  constructor(private readonly library: LibraryService) {}

  @Get()
  list(@UserId() userId: string) {
    return this.library.listBrandKits(userId);
  }

  @Post()
  create(@UserId() userId: string, @Body() body: unknown) {
    return this.library.createBrandKit(userId, parse(BrandBody, body));
  }

  @Get(':id')
  get(@UserId() userId: string, @Param('id') id: string) {
    return this.library.getBrandKit(userId, id);
  }

  @Patch(':id')
  update(@UserId() userId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.library.updateBrandKit(userId, id, parse(BrandPatch, body));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@UserId() userId: string, @Param('id') id: string) {
    return this.library.removeBrandKit(userId, id);
  }
}

/** 角色库与品牌套件（docs/02-prd.md 4.7）；生成任务通过 LibraryService.snapshot() 引用 */
@Module({
  imports: [SafetyModule],
  controllers: [CharactersController, BrandKitsController],
  providers: [LibraryService],
  exports: [LibraryService],
})
export class LibraryModule {}
