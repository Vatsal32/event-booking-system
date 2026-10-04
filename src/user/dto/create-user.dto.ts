import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({
    description: 'Unique username for the user',
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
    description:
      'User password (any non-empty string; 8+ characters recommended). Stored only as a bcrypt hash.',
    example: 'securePassword123',
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}
