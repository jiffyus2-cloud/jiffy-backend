import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class AiService {
  async runSupportChat(message: string, conversationHistory?: { role: string, content: string }[]) {
    const apiKey = process.env.ONECLIC_API_KEY || process.env.VITE_1CLIC_API_KEY;

    if (!apiKey) {
      throw new HttpException('API Key de IA no configurada', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    const endpoint = 'https://www.1clic.ai/api/v1/run';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model_id: 'fd78b2d1-f77d-4fda-b866-3b44b14c15f9',
          inputs: {
            message,
            conversation_history: conversationHistory || [],
          },
        }),
      });

      if (!response.ok) {
        const statusCode = response.status;
        const errorText = await response.text();
        let errorMessage = errorText;

        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorText;
        } catch (e) {
          errorMessage = errorMessage.replace(/<[^>]*>?/gm, '').trim();
        }

        console.error(`1clic.ai (support-chat) devolvió HTTP ${statusCode}:`, errorMessage);

        if (statusCode === 404) {
          throw new Error(`Endpoint de la IA no encontrado (HTTP 404). Verifica la URL: ${endpoint}`);
        }

        throw new Error(`Error de la API (HTTP ${statusCode}): ${errorMessage}`);
      }

      const result = await response.json();

      return {
        success: true,
        reply: result.output || '',
        usage: result.usage,
      };

    } catch (error: any) {
      console.error('Error procesando chat de soporte:', error.message || error);
      throw new HttpException(
        error.message || 'Error interno al comunicarse con el proveedor de IA',
        HttpStatus.BAD_GATEWAY
      );
    }
  }
}