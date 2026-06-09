import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class AiService {
  async sortPhotos(photosData: any[], pageCount?: number, layoutPreferences?: any) {
    const apiKey = process.env.ONECLIC_API_KEY || process.env.VITE_1CLIC_API_KEY;

    if (!apiKey) {
      throw new HttpException('API Key de IA no configurada', HttpStatus.INTERNAL_SERVER_ERROR);
    }

    // El endpoint proporcionado en la documentación que pasaste.
    // Si sigue dando 404, deberás revisar el panel de 1clic.ai para confirmar la URL exacta.
    const endpoint = 'https://www.1clic.ai/api/v1/run';

    try {
      console.log(`Enviando petición a 1clic.ai (${endpoint})...`);
      
      const response = await fetch(endpoint, {
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

      // MANEJO MEJORADO DE ERRORES HTTP
      if (!response.ok) {
        const statusCode = response.status;
        const errorText = await response.text();
        let errorMessage = errorText;
        
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error || errorJson.message || errorText;
        } catch(e) {
          // Es un string plano o HTML (como el 404 que estamos viendo)
          // Limpiamos etiquetas HTML si existen para un log más limpio
          errorMessage = errorMessage.replace(/<[^>]*>?/gm, '').trim();
        }

        console.error(`1clic.ai devolvió HTTP ${statusCode}:`, errorMessage);
        
        // Si es 404, lanzamos un error claro
        if (statusCode === 404) {
          throw new Error(`Endpoint de la IA no encontrado (HTTP 404). Verifica la URL: ${endpoint}`);
        }

        throw new Error(`Error de la API (HTTP ${statusCode}): ${errorMessage}`);
      }

      const result = await response.json();

      let rawOutput = result.output || '';
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/); 
      
      if (!jsonMatch) {
         throw new Error(`La IA no devolvió JSON válido. Output crudo: ${rawOutput.substring(0, 50)}...`);
      }

      const cleanJsonString = jsonMatch[0];
      const output = JSON.parse(cleanJsonString);

      return {
        success: true,
        ...output,
        usage: result.usage,
      };

    } catch (error: any) {
      console.error('Error procesando IA:', error.message || error);
      throw new HttpException(
        error.message || 'Error interno al comunicarse con el proveedor de IA', 
        HttpStatus.BAD_GATEWAY
      );
    }
  }
}