import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    description: 'Registered username',
    example: 'john_doe',
    minLength: 5,
    maxLength: 30,
  })
  @IsString()
  @MinLength(5)
  @MaxLength(30)
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    description: 'User password',
    example: 'securePassword123',
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}