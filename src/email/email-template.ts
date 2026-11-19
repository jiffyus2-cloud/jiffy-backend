/**
 * Plantilla de los correos masivos. El dueño escribe solo el contenido; aquí se
 * envuelve con la cabecera de la marca y el pie legal con el enlace de baja,
 * que no se puede quitar (Ley 1581 de 2012 en Colombia, CAN-SPAM en EE. UU.).
 *
 * `{{nombre}}` en el asunto o el cuerpo se sustituye por el nombre de pila del
 * destinatario (vacío si no lo tenemos).
 */
export type EmailBodyFormat = 'html' | 'text';

export interface RenderInput {
  subject: string;
  body: string;
  format: EmailBodyFormat;
  recipientName?: string;
  unsubscribeUrl: string;
  postalAddress?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const NAME_PLACEHOLDER = /\{\{\s*nombre\s*\}\}/gi;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function firstName(name?: string): string {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

/** Texto plano aproximado a partir del HTML del dueño (para la parte text/plain). */
export function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|tr)\s*>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(paragraph => `<p style="margin:0 0 16px">${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function renderEmail(input: RenderInput): RenderedEmail {
  const name = firstName(input.recipientName);
  const subject = input.subject
    .replace(NAME_PLACEHOLDER, name)
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const contentHtml = input.format === 'html'
    ? input.body.replace(NAME_PLACEHOLDER, escapeHtml(name))
    : textToHtml(input.body.replace(NAME_PLACEHOLDER, name));
  const contentText = input.format === 'html'
    ? htmlToText(input.body.replace(NAME_PLACEHOLDER, name))
    : input.body.replace(NAME_PLACEHOLDER, name).trim();

  const unsubscribeUrl = escapeHtml(input.unsubscribeUrl);
  const postal = input.postalAddress ? escapeHtml(input.postalAddress) : '';

  const html = `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f4;font-family:Helvetica,Arial,sans-serif;color:#1c1917">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f4">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px">
        <tr><td style="padding:24px 32px 8px;font-size:20px;font-weight:bold;letter-spacing:-0.5px">Jiffy Photos</td></tr>
        <tr><td style="padding:8px 32px 24px;font-size:15px;line-height:1.6">${contentHtml}</td></tr>
      </table>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
        <tr><td style="padding:16px 32px;font-size:12px;line-height:1.5;color:#78716c;text-align:center">
          Recibes este correo porque tienes una cuenta en Jiffy Photos (jiffyphotos.com).<br>
          Si no quieres recibir más comunicaciones como esta, <a href="${unsubscribeUrl}" style="color:#78716c">date de baja aquí</a>.
          ${postal ? `<br>${postal}` : ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = [
    contentText,
    '',
    '—',
    'Recibes este correo porque tienes una cuenta en Jiffy Photos (jiffyphotos.com).',
    `Para darte de baja: ${input.unsubscribeUrl}`,
    ...(input.postalAddress ? [input.postalAddress] : []),
  ].join('\n');

  return { subject, html, text };
}
