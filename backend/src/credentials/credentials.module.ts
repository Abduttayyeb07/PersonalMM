import { Module } from '@nestjs/common';
import { CredentialsService } from './credentials.service';
import { CredentialsController } from './credentials.controller';
import { EncryptionModule } from '../encryption/encryption.module';
import { AuthModule } from '../auth/auth.module';
import { CredentialLifecycleService } from './credential-lifecycle.service';

@Module({
  imports: [EncryptionModule, AuthModule],
  providers: [CredentialsService, CredentialLifecycleService],
  controllers: [CredentialsController],
  exports: [CredentialsService, CredentialLifecycleService],
})
export class CredentialsModule {}
