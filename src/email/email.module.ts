import { Module } from '@nestjs/common';
import { EmailController, UnsubscribeController } from './email.controller';
import { EmailService } from './email.service';
import { OrderEmailService } from './order-email.service';

/** Correos masivos a usuarios registrados, correos automáticos de pedido y baja pública. */
@Module({
  providers: [EmailService, OrderEmailService],
  exports: [OrderEmailService],
  controllers: [UnsubscribeController, EmailController],
})
export class EmailModule {}
