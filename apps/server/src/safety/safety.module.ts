import { Module } from '@nestjs/common';
import { LabelingService } from './labeling.service';
import { ModerationService } from './moderation.service';

/** 内容安全：审核与 AI 标识，供生成任务与素材上传共用 */
@Module({
  providers: [ModerationService, LabelingService],
  exports: [ModerationService, LabelingService],
})
export class SafetyModule {}
