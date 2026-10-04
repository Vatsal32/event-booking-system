import { Injectable, UnauthorizedException, ConflictException, InternalServerErrorException } from '@nestjs/common';
import { hash, compare } from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import { CreateUserDto } from './dto/create-user.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { User } from './entities/user.entity.js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError } from 'typeorm';
import { AppConfigService } from '../config/config.service.js';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CreateTestUsersDto } from './dto/create-test-users.dto.js';

const SALT_ROUNDS = 10;

export interface TestUser {
  id: number;
  username: string;
  token: string;
}

@Injectable()
export class UserService {
  /**
   * One real bcrypt hash of a random secret nobody knows, shared by every test user: logging in
   * as them fails with a normal 401 (a non-bcrypt placeholder could make compare() throw), and
   * no bcrypt work happens per test user.
   */
  private testUserPasswordHash: Promise<string> | null = null;

  constructor(
    @InjectPinoLogger(UserService.name)
    private readonly logger: PinoLogger,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly jwtService: JwtService,
    private readonly configService: AppConfigService,
  ) {}

  async create(createUserDto: CreateUserDto) {
    const user = new User();

    user.username = createUserDto.username;
    user.passwordHash = await hash(createUserDto.password, SALT_ROUNDS);

    try {
      return await this.userRepository.save(user);
    } catch (error) {
      if (error instanceof QueryFailedError) {
        this.logger.error(error);
        const pgError = error.driverError as { code?: string; detail?: string };
        if (pgError?.code === '23505') {
          if (pgError.detail?.includes('username')) {
            throw new ConflictException('Username already exists');
          }
          throw new ConflictException('Duplicate entry');
        }
      }
      // anything else (pool timeout, DB down, ...) is classified by AllExceptionsFilter
      throw error;
    }
  }

  async login(loginDto: LoginDto) {
    const user = await this.userRepository.findOne({
      where: { username: loginDto.username },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isPasswordValid = await compare(loginDto.password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    try {
      const payload = { sub: user.id, username: user.username, role: 'user' };
      const accessToken = await this.jwtService.signAsync(payload);

      return {
        accessToken,
        tokenType: 'bearer',
        expiresIn: 3600,
        userId: user.id,
        username: user.username,
        role: 'user',
      };
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException(
        'Failed to generate authentication token',
      );
    }
  }

  async adminToken(adminKey: string) {
    if (adminKey !== this.configService.adminKey) {
      throw new UnauthorizedException('Invalid admin key');
    }

    try {
      const payload = { sub: 0, username: 'admin', role: 'admin' };
      const accessToken = await this.jwtService.signAsync(payload);

      return {
        accessToken,
        tokenType: 'bearer',
        expiresIn: 3600,
        userId: 0,
        username: 'admin',
        role: 'admin',
      };
    } catch (error) {
      this.logger.error(error);
      throw new InternalServerErrorException('Failed to generate admin token');
    }
  }

  /**
   * Creates (or reuses) `count` users named "<prefix>_00001".. and returns a user token for each,
   * so load tests (scripts/load-reserve.ts, ./burst.sh) need only the API and the admin key.
   * One INSERT and one SELECT regardless of count; tokens are signed in-process.
   */
  async createTestUsers({ count, prefix }: CreateTestUsersDto): Promise<TestUser[]> {
    const usernames = Array.from(
      { length: count },
      (_, i) => `${prefix}_${String(i + 1).padStart(5, '0')}`,
    );
    this.testUserPasswordHash ??= hash(
      randomBytes(32).toString('hex'),
      SALT_ROUNDS,
    );
    const passwordHash = await this.testUserPasswordHash;

    const metadata = this.userRepository.metadata;
    const table = metadata.tablePath;
    const usernameColumn =
      metadata.findColumnWithPropertyName('username')!.databaseName;
    const passwordColumn =
      metadata.findColumnWithPropertyName('passwordHash')!.databaseName;
    const idColumn = metadata.findColumnWithPropertyName('id')!.databaseName;

    await this.userRepository.query(
      `INSERT INTO "${table}" ("${usernameColumn}", "${passwordColumn}")
       SELECT u, $2 FROM unnest($1::text[]) AS u
       ON CONFLICT ("${usernameColumn}") DO NOTHING`,
      [usernames, passwordHash],
    );
    const rows: { id: number; username: string }[] =
      await this.userRepository.query(
        `SELECT "${idColumn}" AS id, "${usernameColumn}" AS username
           FROM "${table}"
          WHERE "${usernameColumn}" = ANY($1::text[])
          ORDER BY "${usernameColumn}"`,
        [usernames],
      );

    return Promise.all(
      rows.map(async (row) => ({
        id: Number(row.id),
        username: row.username,
        token: await this.jwtService.signAsync({
          sub: Number(row.id),
          username: row.username,
          role: 'user',
        }),
      })),
    );
  }

  async findById(id: number) {
    return this.userRepository.findOne({ where: { id } });
  }
}
