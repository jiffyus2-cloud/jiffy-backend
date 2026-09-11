import { Controller, Post, Body } from '@nestjs/common';
import { AiService } from './ai.service';

// `POST /ai/sort-photos` vivió aquí hasta 2026-09: ordenaba las fotos del álbum
// con un modelo de 1clic.ai. El frontend ya ordena en local (orden de selección
// del carrete, con el nombre de archivo como respaldo), así que se retiró.
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('support-chat')
  async supportChat(@Body() body: { message: string, conversation_history?: { role: string, content: string }[] }) {
    return this.aiService.runSupportChat(body.message, body.conversation_history);
  }
}
