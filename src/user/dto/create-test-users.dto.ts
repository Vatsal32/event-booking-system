import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsOptional, Matches, Max, Min } from 'class-validator';

export const MAX_TEST_USERS = 50_001;

export class CreateTestUsersDto {
  @ApiProperty({
    description: `How many test users to create (or reuse), 1-${MAX_TEST_USERS}`,
    example: 500,
    minimum: 1,
    maximum: MAX_TEST_USERS,
  })
  @IsInt()
  @Min(1)
  @Max(MAX_TEST_USERS)
  count: number;

  @ApiProperty({
    description:
      'Username prefix: users are named "<prefix>_00001", "<prefix>_00002", ... Re-using a prefix reuses the same users.',
    example: 'lt',
    required: false,
    default: 'lt',
    pattern: '^[a-z0-9]{1,12}$',
  })
  @IsOptional()
  @Matches(/^[a-z0-9]{1,12}$/, {
    message: 'prefix must be 1-12 lowercase letters or digits',
  })
  prefix: string = 'lt';
}
