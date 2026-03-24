import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class AiService {
  async sortPhotos(photosData: any[], pageCount?: number, layoutPreferences?: any) {
    const apiKey = process.env.ONECLIC_API_KEY || process.env.VITE_1CLIC_API_KEY;

    if (!apiKey) {
      throw new HttpException('API Key de IA no configurada', HttpStatus.INTERNAL_SERVER_ERROR);
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
            page_count: pageCount || 40,
            layout_preferences: layoutPreferences || {}
          },
        }),
      });

      // 1. MANEJO SEGURO DE ERRORES HTTP (Evita crash si la API devuelve texto en vez de JSON)
      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = errorText;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorText;
        } catch(e) {
          // Si falla el parseo, mantenemos el errorText original
        }
        throw new Error(`Error de la API: ${errorMessage}`);
      }

      const result = await response.json();

      // 2. EXTRACCIÓN DEFENSIVA DEL JSON
      let rawOutput = result.output || '';
      
      // Buscar el bloque que empiece con '{' y termine con '}' ignorando texto alrededor
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/); 
      
      if (!jsonMatch) {
         throw new Error(`La IA no devolvió un formato JSON válido. Respuesta: ${rawOutput.substring(0, 100)}...`);
      }

      const cleanJsonString = jsonMatch[0];
      const output = JSON.parse(cleanJsonString);

      return {
        success: true,
        ...output,
        usage: result.usage,
      };

    } catch (error: any) {
      // Ahora el log mostrará el mensaje real en vez del error genérico de parseo
      console.error('Error en el servicio de IA:', error.message || error);
      throw new HttpException(
        error.message || 'Error interno al procesar las imágenes', 
        HttpStatus.BAD_GATEWAY
      );
    }
  }
}