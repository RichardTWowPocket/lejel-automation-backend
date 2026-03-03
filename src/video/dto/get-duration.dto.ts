import { IsString, IsNotEmpty } from 'class-validator';

export class GetDurationDto {
    @IsString()
    @IsNotEmpty()
    url: string;
}
