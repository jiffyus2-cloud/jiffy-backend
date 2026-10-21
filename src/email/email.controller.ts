import { Body, Controller, Get, HttpCode, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { OwnerGuard } from '../middleware/owner.guard';
import { escapeHtml } from './email-template';
import { EmailService } from './email.service';

/** URL pública con la que nos han llamado (Cloud Run termina TLS delante). */
function requestBaseUrl(req: any): string {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

/** Rutas del panel del dueño (pestaña "Correos"). */
@Controller('email')
@UseGuards(OwnerGuard)
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  /** Qué falta configurar (nombres de variables, nunca valores). */
  @Get('status')
  status() {
    return this.emailService.status();
  }

  /** Cuántos destinatarios tiene un segmento, descontadas las bajas. */
  @Post('audience')
  @HttpCode(200)
  audience(@Body() body: { segment?: string }) {
    return this.emailService.audience(body?.segment);
  }

  /** El correo tal como lo recibirá un destinatario de ejemplo. */
  @Post('preview')
  @HttpCode(200)
  preview(@Body() body: unknown, @Req() req: any) {
    return this.emailService.preview(body, requestBaseUrl(req));
  }

  @Post('test')
  @HttpCode(200)
  sendTest(@Body() body: unknown, @Req() req: any) {
    return this.emailService.sendTest(body, requestBaseUrl(req));
  }

  @Get('campaigns')
  campaigns(@Query('limit') limit?: string) {
    return this.emailService.listCampaigns(Number(limit) || 50);
  }

  @Post('campaigns')
  sendCampaign(@Body() body: unknown, @Req() req: any) {
    return this.emailService.sendCampaign(body, String(req.user?.email || ''), requestBaseUrl(req));
  }
}

/**
 * Baja pública (sin sesión): es el enlace del pie de cada correo.
 *
 * - `GET` solo muestra un botón de confirmación: los antivirus y previsualizadores
 *   de correo abren los enlaces solos y no deben dar de baja a nadie.
 * - `POST` da de baja. Lo usa el botón de la página y la baja en un clic de
 *   Gmail/Yahoo (`List-Unsubscribe-Post`, RFC 8058).
 */
@Controller('email/unsubscribe')
export class UnsubscribeController {
  constructor(private readonly emailService: EmailService) {}

  @Get()
  confirmPage(@Query('token') token: string, @Res() res: any) {
    if (isSampleToken(token)) {
      return send(res, 200, page('Enlace de muestra', 'Este es el enlace de baja de un correo de prueba o de la vista previa: no da de baja a nadie.'));
    }
    const action = `?token=${encodeURIComponent(token || '')}`;
    return send(res, 200, page(
      '¿Darte de baja?',
      'Dejarás de recibir los correos informativos y promocionales de Jiffy Photos. Los avisos sobre tus pedidos seguirán llegando.',
      `<form method="post" action="${escapeHtml(action)}"><button type="submit" style="margin-top:16px;padding:12px 24px;border:0;border-radius:8px;background:#1c1917;color:#fff;font-size:15px;cursor:pointer">Confirmar baja</button></form>`,
    ));
  }

  @Post()
  async unsubscribe(@Query('token') token: string, @Body() body: any, @Res() res: any) {
    if (isSampleToken(token)) {
      return send(res, 200, page('Enlace de muestra', 'Este enlace es de un correo de prueba: no da de baja a nadie.'));
    }
    const oneClick = String(body?.['List-Unsubscribe'] || '') === 'One-Click';
    const ok = await this.emailService.unsubscribe(String(token || ''), oneClick ? 'one-click' : 'link');
    if (!ok) {
      return send(res, 400, page('Enlace no válido', 'No hemos podido reconocer este enlace de baja. Escríbenos a memorias@jiffyphotos.com y te damos de baja a mano.'));
    }
    return send(res, 200, page('Te has dado de baja', 'No volverás a recibir nuestros correos informativos. Los avisos sobre tus pedidos seguirán llegando.'));
  }
}

function isSampleToken(token: unknown): boolean {
  return token === 'prueba' || token === 'vista-previa';
}

function send(res: any, status: number, html: string) {
  res.status(status).type('html').send(html);
}

function page(title: string, message: string, extra = ''): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · Jiffy Photos</title></head>
<body style="margin:0;background:#f5f5f4;font-family:Helvetica,Arial,sans-serif;color:#1c1917">
<main style="max-width:480px;margin:64px auto;padding:32px;background:#fff;border-radius:12px;text-align:center">
<p style="font-weight:bold;font-size:18px;margin:0 0 24px">Jiffy Photos</p>
<h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(title)}</h1>
<p style="line-height:1.6;color:#57534e;margin:0">${escapeHtml(message)}</p>${extra}
</main></body></html>`;
}
