import { Controller, Post, Body, HttpCode, HttpStatus, Headers, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiHeader, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { UserService } from './user.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { LoginResponseDto } from './dto/login-response.dto.js';
import { CreateTestUsersDto, MAX_TEST_USERS } from './dto/create-test-users.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';

@ApiTags('Authentication')
@Controller('user')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Register a new user',
    description: 'Creates a new user account with username and password. The password will be securely hashed before storage.',
  })
  @ApiBody({
    type: CreateUserDto,
    examples: {
      validUser: {
        summary: 'Valid registration request',
        value: {
          username: 'john_doe',
          password: 'securePassword123',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'User successfully created (the password hash is never returned)',
    schema: {
      example: {
        username: 'john_doe',
        id: 1,
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error: username must be 5-30 characters, password must be a non-empty string',
  })
  @ApiResponse({
    status: 409,
    description: 'Username already exists',
  })
  @ApiResponse({
    status: 429,
    description:
      'The server is busy or the database is temporarily unavailable; retry after the Retry-After header',
  })
  async create(@Body() createUserDto: CreateUserDto) {
    const user = await this.userService.create(createUserDto);
    return {
      username: user.username,
      id: user.id,
    };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'User login',
    description: 'Authenticates a user with username and password. Returns a JWT access token with role "user" that expires in 1 hour.',
  })
  @ApiBody({
    type: LoginDto,
    examples: {
      validLogin: {
        summary: 'Valid login request',
        value: {
          username: 'john_doe',
          password: 'securePassword123',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Login successful - returns JWT token',
    type: LoginResponseDto,
    example: {
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      tokenType: 'bearer',
      expiresIn: 3600,
      userId: 1,
      username: 'john_doe',
      role: 'user',
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation error: username must be 5-30 characters, password must be a non-empty string',
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials - username not found or password incorrect',
    schema: {
      example: {
        statusCode: 401,
        message: 'Invalid credentials',
        error: 'Unauthorized',
      },
    },
  })
  @ApiResponse({
    status: 429,
    description:
      'The server is busy or the database is temporarily unavailable; retry after the Retry-After header',
  })
  async login(@Body() loginDto: LoginDto) {
    return this.userService.login(loginDto);
  }

  @Post('admin-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate admin token',
    description: 'Generates a JWT token with admin role. Requires the x-admin-key header to match the ADMIN_KEY environment variable. Use this for administrative access.',
  })
  @ApiHeader({
    name: 'x-admin-key',
    description: 'Admin secret key (must match ADMIN_KEY env variable)',
    required: true,
    schema: { type: 'string', example: 'super-secret-admin-key-123' },
  })
  @ApiResponse({
    status: 200,
    description: 'Admin token generated successfully',
    type: LoginResponseDto,
    example: {
      accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      tokenType: 'bearer',
      expiresIn: 3600,
      userId: 0,
      username: 'admin',
      role: 'admin',
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid admin key provided',
    schema: {
      example: {
        statusCode: 401,
        message: 'Invalid admin key',
        error: 'Unauthorized',
      },
    },
  })
  async adminToken(@Headers('x-admin-key') adminKey: string) {
    return this.userService.adminToken(adminKey);
  }

  @Post('test-tokens')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Create test users and their tokens (admin only)',
    description: `For load tests: creates (or reuses) up to ${MAX_TEST_USERS} users named "<prefix>_00001", "<prefix>_00002", ... and returns a user token (1h) for each. Re-using a prefix returns the same users. Test users cannot log in with a password. Used by ./burst.sh and scripts/load-reserve.ts, so they need only the API URL and the admin key.`,
  })
  @ApiBody({
    type: CreateTestUsersDto,
    examples: {
      fiveHundred: {
        summary: '500 test users',
        value: { count: 500, prefix: 'lt' },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Test users and their tokens, ordered by username',
    schema: {
      example: {
        users: [
          { id: 101, username: 'lt_00001', token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
          { id: 102, username: 'lt_00002', token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' },
        ],
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: `count is not an integer between 1 and ${MAX_TEST_USERS}, or prefix is not 1-12 lowercase letters/digits`,
  })
  @ApiResponse({ status: 401, description: 'JWT missing, invalid or expired' })
  @ApiResponse({ status: 403, description: 'Forbidden - Admin role required' })
  @ApiResponse({
    status: 429,
    description:
      'The server is busy or the database is temporarily unavailable; retry after the Retry-After header',
  })
  async createTestUsers(@Body() dto: CreateTestUsersDto) {
    return { users: await this.userService.createTestUsers(dto) };
  }
}
