import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AssemblyAIService } from './assemblyai.service';

@Module({
    imports: [ConfigModule],
    providers: [AssemblyAIService],
    exports: [AssemblyAIService],
})
export class AssemblyAIModule { }
