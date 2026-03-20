import { Controller, Post, Body } from '@nestjs/common';
import { AiService } from './ai.service';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('sort-photos')
  async sortPhotos(@Body() body: { photos: any[] }) {
    // Recibimos las fotos del frontend y se las pasamos a nuestro servicio
    return this.aiService.sortPhotos(body.photos);
  }
}