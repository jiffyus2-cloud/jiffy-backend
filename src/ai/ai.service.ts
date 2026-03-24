import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class AiService {
  async sortPhotos(photosData: any[], pageCount?: number, layoutPreferences?: any) {
    // Asegúrate de que la variable de entorno coincida con la que tienes configurada
    const apiKey = process.env.ONECLIC_API_KEY || process.env.VITE_1CLIC_API_KEY;

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
          model_id: '53893e5c-cc14-4432-b98b-88e8782b2f8b',
          inputs: { 
            photos_data: photosData,
            page_count: pageCount || 40, // Valor por defecto basado en tu UI
            layout_preferences: layoutPreferences || {}
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`Error de la IA: ${errorData.error || response.statusText}`);
      }

      const result = await response.json();

      // Parseamos la respuesta del agente limpiando el formato markdown
      const output = JSON.parse(
        result.output.replace(/```json|\n```|```/g, "").trim()
      );

      // Devolvemos la estructura limpia al frontend
      return {
        success: true,
        ...output,
        usage: result.usage,
      };

    } catch (error: any) {
      console.error('Error en el servicio de IA:', error);
      throw new HttpException('Error interno al procesar las imágenes con IA', HttpStatus.BAD_GATEWAY);
    }
  }
}