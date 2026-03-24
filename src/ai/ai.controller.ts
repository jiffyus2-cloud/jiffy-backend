import { Controller, Post, Body } from '@nestjs/common';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('sort-photos')
  async sortPhotos(@Body() body: { photos_data: any[], page_count?: number, layout_preferences?: any }) {
    return this.aiService.sortPhotos(body.photos_data, body.page_count, body.layout_preferences);
  }
}