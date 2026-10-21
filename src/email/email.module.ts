import { Module } from '@nestjs/common';
import { EmailController, UnsubscribeController } from './email.controller';
import { EmailService } from './email.service';

/** Correos masivos a usuarios registrados + baja pública. */
@Module({
  providers: [EmailService],
  controllers: [UnsubscribeController, EmailController],
})
export class EmailModule {}
