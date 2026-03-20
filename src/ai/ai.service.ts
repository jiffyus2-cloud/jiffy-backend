import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class AiService {
  async sortPhotos(photosData: any[]) {
    // Soportamos el prefijo VITE_ por si usas el mismo nombre de variable que en el frontend
    const apiKey = process.env.VITE_1CLIC_API_KEY;

    if (!apiKey) {
      throw new HttpException('API Key de IA no configurada en el servidor', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    try {
      const response = await fetch('https://app.1clic.ai/api/v1/run', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          agentId: '53893e5c-cc14-4432-b98b-88e8782b2f8b',
          action: 'sort_photos',
          photos: photosData,
        }),
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Error de la IA: ${errorData}`);
      }

      return await response.json();
    } catch (error: any) {
      console.error('Error en el servicio de IA:', error);
      throw new HttpException('Error interno al ordenar fotos', HttpStatus.BAD_GATEWAY);
    }
  }
}