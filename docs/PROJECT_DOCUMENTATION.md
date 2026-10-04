# Event Booking System - Project Documentation

## Overview

The **Event Booking System** is a NestJS-based backend service for managing event shows and seat bookings. It provides RESTful APIs for user authentication, show management (admin), and seat booking functionality.

**Tech Stack:**
- **Framework:** NestJS 12.x (TypeScript)
- **Database:** PostgreSQL with TypeORM
- **Authentication:** JWT (Passport.js)
- **Validation:** class-validator + class-transformer
- **Documentation:** Swagger/OpenAPI
- **Logging:** Pino (nestjs-pino) + OpenTelemetry
- **Metrics:** Prometheus (`prom-client`) + OpenTelemetry
- **Observability:** Traceway (OTLP/HTTP)
- **Package Manager:** pnpm

---

## Project Structure

```
src/
├── app.module.ts              # Root module
├── main.ts                    # Application bootstrap
├── config/                    # Configuration module
│   ├── config.module.ts
│   ├── config.service.ts
│   └── config.ts
├── auth/                      # Authentication module
│   ├── auth.module.ts
│   ├── jwt.strategy.ts
│   ├── jwt-auth.guard.ts
│   ├── roles.guard.ts
│   └── roles.decorator.ts
├── user/                      # User management module
│   ├── user.module.ts
│   ├── user.controller.ts
│   ├── user.service.ts
│   ├── entities/
│   │   └── user.entity.ts
│   └── dto/
│       ├── create-user.dto.ts
│       ├── login.dto.ts
│       └── login-response.dto.ts
├── show/                      # Show management module
│   ├── show.module.ts
│   ├── show.controller.ts
│   ├── show.service.ts
│   ├── entities/
│   │   ├── show.entity.ts
│   │   └── seat.entity.ts
│   └── dto/
│       ├── create-show.dto.ts
│       └── show-response.dto.ts
├── health/                    # Health check endpoints
│   ├── health.controller.ts
│   └── health.module.ts
└── common/
    └── validators/
        └── is-positive-integer.validator.ts
```

---

## Configuration

### Environment Variables (`.env`)

```env
NODE_ENV=development
PORT=8080
LOG_LEVEL=debug
JWT_SECRET=your-super-secret-jwt-key
ADMIN_KEY=your-admin-secret-key
TRACEWAY_ENDPOINT=http://localhost:8082

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=
DB_PASSWORD=
DB_DATABASE=
```

### Config Service (`src/config/config.service.ts`)

```typescript
@Injectable()
export class AppConfigService {
  get env(): Environment;
  get port(): string;
  get logLevel(): string;
  get jwtSecret(): string;
  get adminKey(): string;
  get database(): DatabaseConfig;
  get tracewayEndpoint(): string;
  get tracewayToken(): string;
}
```

**ConfigModule** (`src/config/config.module.ts`) is `@Global()` and exports `AppConfigService` for use across modules.

---

## Authentication System

### JWT Strategy (`src/auth/jwt.strategy.ts`)

- Extends `PassportStrategy(Strategy, 'jwt')`
- Extracts token from `Authorization: Bearer <token>` header
- Validates payload: `{ sub, username, role }`
- For admin tokens (`sub: 0`), returns without DB lookup
- For user tokens, verifies user exists via `UserService.findById()`

### Guards

| Guard | Purpose |
|-------|---------|
| `JwtAuthGuard` | Requires valid JWT token, attaches `req.user` |
| `RolesGuard` | Checks `req.user.role` against `@Roles(...)` decorator |

### Decorators

```typescript
@Roles('admin')           // Single role
@Roles('user', 'admin')   // Multiple allowed roles
```

### User Service (`src/user/user.service.ts`)

```typescript
async create(createUserDto: CreateUserDto)     // Register user (hashes password)
async login(loginDto: LoginDto)                // Validate credentials, return JWT + role: 'user'
async adminToken(adminKey: string)             // Verify ADMIN_KEY, return JWT + role: 'admin'
async findById(id: number)                     // Used by JWT strategy
```

---

## User Module

### Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/user/register` | Public | Register new user |
| POST | `/user/login` | Public | Login, returns JWT (role: user) |
| POST | `/user/admin-token` | Header `x-admin-key` | Generate admin JWT (role: admin) |
| POST | `/user/test-tokens` | JWT (admin) | Create or reuse up to 20,000 test users (`<prefix>_00001`, …) and return a user token for each; used by `./burst.sh` and `scripts/load-reserve.ts` |

### DTOs

**CreateUserDto**
```typescript
username: string (5-30 chars, unique)
password: string (min 8 chars)
```

**LoginDto** - Same as CreateUserDto

**LoginResponseDto**
```typescript
accessToken: string       // JWT
tokenType: 'bearer'
expiresIn: 3600           // seconds
userId: number            // 0 for admin
username: string
role: 'user' | 'admin'
```

### Error Handling

| Scenario | HTTP Code | Message |
|----------|-----------|---------|
| Username exists | 409 | "Username already exists" |
| Invalid credentials | 401 | "Invalid credentials" |
| Invalid admin key | 401 | "Invalid admin key" |
| Validation error | 400 | Field-specific messages |

---

## Show Module

### Entities

#### Show (`src/show/entities/show.entity.ts`)

```typescript
id: number
name: string (not unique; shows are identified by id)
pricePaise: number (bigint)    // Price in PAISE (integer)
perUserLimit: number (default: 4)
seats: Seat[]
createdAt: Date
updatedAt: Date
```

#### Seat (`src/show/entities/seat.entity.ts`)

```typescript
seatId: number
seatNumber: string (max 10)
status: 'AVAILABLE' | 'HOLD' | 'RESERVED'
reservedBy: number | null      // owner while HOLD or RESERVED
heldUntil: Date | null         // only set while HOLD; the hold lapses once this passes
reservationId: number | null   // the hold/reserve request that last claimed the seat
showId: number (FK)
show: Show
createdAt: Date
updatedAt: Date
```

**Unique Index:** `(showId, seatNumber)`

### Seat states: hold vs reserve

| State | API status | Meaning | Becomes free? |
|-------|------------|---------|---------------|
| `AVAILABLE` | `available` | Free | — |
| `HOLD` | `held` | Temporarily locked for one user until `held_until` | Yes: once `held_until` passes, or when the owner cancels |
| `RESERVED` | `confirmed` | Reserved for good | Only if its owner cancels it |

**Why two endpoints:**
- `POST /shows/:id/hold` is a short, time-boxed lock while the user decides or pays. It lapses on its own, so an abandoned checkout never blocks a seat for long. This is the "time-boxed hold that auto-expires" release model.
- `POST /shows/:id/reserve` is the sale. It never expires; only its owner can release it, with `POST /reservations/:id/cancel`.
- `POST /reservations/:id/cancel` (owner only) releases a hold's or a reservation's seats back to available, so they can be booked again straight away. Someone else's reservation id gets 404, like an unknown one. Only seats still linked to that reservation are released, so a seat someone else has taken since (e.g. after the hold expired) is never touched. Cancelling twice is harmless (200, nothing released). It runs `cancel_reservation()` in one atomic call, with the same lock order as `claim_seats()`.
- Holding first is optional: `/reserve` accepts seats that are free **or** that the caller currently holds.
- Another user's unexpired hold blocks both endpoints (409 `SEAT_TAKEN`).
- The per-user limit counts reserved seats plus unexpired holds. Turning your own hold into a reservation doesn't change your count.
- Both endpoints run the same database function, `claim_seats()` (`src/show/reserve-seats.sql.ts`), in one atomic call. Multi-seat requests are all-or-nothing.
- The idempotency key can be sent as the `idempotency_key` body field (preferred), the `idempotencyKey` body field, or an `Idempotency-Key` header. The same key in several places is fine; two different keys in one request, or no key at all, gets a 400.

### Endpoints

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| POST | `/shows` | JWT | admin | Create show with seats |
| GET | `/shows/:id` | Public | - | Get show with all seats, per-status counts and total |
| POST | `/shows/:id/hold` | JWT | user | Temporarily hold seats (status `held`, lapses at `held_until`) |
| POST | `/shows/:id/reserve` | JWT | user | Reserve seats for good (status `confirmed`); accepts free seats or seats you hold |
| POST | `/reservations/:id/cancel` | JWT | user (owner) | Release your own hold or reservation; its seats become available again |

### Create Show Request

```json
POST /shows
Authorization: Bearer <admin-token>
{
  "name": "friday-night",
  "seats": ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5"],
  "price_paise": 25000,
  "per_user_limit": 4
}
```

### Response (201 Created)

```json
{
  "id": 1,
  "name": "friday-night",
  "seats": [
    { "seat_number": "A1", "status": "available" },
    { "seat_number": "A2", "status": "available" },
    ...
  ],
  "price_paise": 25000,
  "per_user_limit": 4,
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

### Get Show Response (200 OK)

```json
{
  "id": 1,
  "name": "friday-night",
  "seats": [
    { "seat_number": "A1", "status": "confirmed" },
    { "seat_number": "A2", "status": "available" },
    { "seat_number": "A3", "status": "held" },
    ...
  ],
  "counts": { "available": 8, "held": 1, "confirmed": 1 },
  "total_seats": 10,
  "price_paise": 25000,
  "per_user_limit": 4,
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

---

## Money Handling

**All monetary values are stored and transmitted as INTEGER PAISE.**

| Amount | Paise (stored) |
|--------|----------------|
| ₹1.00 | 100 |
| ₹250.00 | 25000 |
| ₹999.99 | 99999 |

**Rules:**
- Never use floating point for money
- `price_paise` is `bigint` in DB, `number` in JS
- Validation ensures positive integer only

---

## Validation & Error Handling

### Global Validation Pipe (`main.ts`)

```typescript
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,                    // Strip unknown properties
  forbidNonWhitelisted: false,        // ...silently, instead of rejecting the request
  transform: true,                    // Transform payloads to DTO instances
  transformOptions: { enableImplicitConversion: true }
}));
```

Unknown body fields are dropped rather than rejected. Identity always comes from the JWT, so a request that sends a spoofed `user_id` (or any other extra field) still succeeds, and it acts only as the token's user. Fields a DTO does declare are still validated as before.

### Custom Validator: `IsPositiveIntegerConstraint`

Rejects:
- Floats: `25000.5`, `25000.0`
- Zero or negative: `0`, `-1`
- Non-numbers: `"25000"`, `null`

Accepts:
- Positive integers: `1`, `25000`, `99999`

### PostgreSQL Error Code Mapping

| PG Code | Error | HTTP Code | Message |
|---------|-------|-----------|---------|
| 23505 | unique_violation (seat_number) | 409 | "Duplicate seat number" |
| 23505 | unique_violation (username) | 409 | "Username already exists" |
| 23503 | foreign_key_violation | 400 | "Invalid show reference" |
| 22001 | string_data_right_truncation | 400 | "Seat number too long (max 10 characters)" |
| 22003 | numeric_value_out_of_range | 400 | "Price value too large" |
| 22P02 | invalid_text_representation (price_paise) | 400 | "Price must be an integer (paise)" |
| 22P02 | invalid_text_representation (status) | 400 | "Invalid seat status value" |

### Error handling under load (global `AllExceptionsFilter`)

`src/common/filters/all-exceptions.filter.ts` catches everything that isn't already an `HttpException`, so an infrastructure problem never becomes a 500. Deliberate responses (every 4xx, and readiness' 503) pass through unchanged.

| Error | HTTP | `reason` |
|-------|------|----------|
| Pool has no free connection in time, `53300`, `57014`, `55P03`, `40P01`, `40001` | 429 + `Retry-After: 1` | `SERVER_BUSY` |
| Database unreachable or connection dropped: `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EPIPE`, "Connection terminated unexpectedly", SQLSTATE `08xxx`, `57P01`–`57P03` | 429 + `Retry-After: 1` | `DB_UNAVAILABLE` |
| SQLSTATE `22xxx` | 400 | `INVALID_INPUT` |
| `23505` | 409 | `CONFLICT` |
| `23503` | 400 | `INVALID_REFERENCE` |
| Anything else (a genuine bug) | 500, logged | `INTERNAL_ERROR` |

Infrastructure failures are answered with 429 rather than 503 because the client should simply retry, ideally with the same idempotency key. `/health/readiness` still returns 503 when the database is down.

**Authentication** trusts the signed JWT: the guard doesn't load the user from the database on each request. A deleted user's token stays valid until it expires (1h). A hold or reserve for a user id that doesn't exist is rejected with 401 `UNKNOWN_USER`.

### Hot-seat storms: losers get 409, not 429

When thousands of users hit the same seat at once, every loser must get a clean 409, even though only ~10 database connections exist. Two pieces in `ShowService.claimSeats` make that happen.

- **Seat cache** (`src/show/seat-cache.ts`): each API instance remembers which seats are taken, by whom, and until when (`held_until` for a hold, forever for a reservation). It learns from every successful hold or reserve and from every `GET /shows/:id`. A request for a seat held or reserved by **another** user gets 409 `SEAT_TAKEN` straight from memory.
  - A cached "taken" is never wrong on this instance: while a seat stays taken its owner never changes, a hold ends at `held_until` (stored in the cache), and the only other way a seat is freed is its owner cancelling, which this instance applies to its cache straight away. With several replicas, another replica could keep a cancelled seat as "taken" until its next `GET /shows/:id` refresh; the service runs as a single replica.
  - An outdated entry can only make a seat look free, which just sends the request to the database, and the database still decides.
  - Seats the caller owns never block, so retries with the same key and hold-then-reserve still reach the database.
- **Claim queue** (`src/common/concurrency/fifo-semaphore.ts`): a FIFO queue in front of the database with one slot per pooled connection.
  - Unlike the pool's internal queue, a request that gets its turn here re-checks the cache before using a connection.
  - So once the winner is known, the rest of the storm drains from memory in milliseconds instead of waiting for the database and timing out.
  - The wait is capped at 4s, shorter than the pool's 5s connection timeout. A request that times out still gets 409 if the seat is known to be taken; otherwise it gets 429 + `Retry-After` (the seats may really be free, and the database is the bottleneck).

Neither piece affects correctness; Postgres (`claim_seats()`) makes every decision. They only control flow under load. The cache is per instance; each instance learns from its own winners and from `GET /shows/:id`.

---

## Database Design

> **How the schema is created:** TypeORM `synchronize: true` creates and updates the tables from the entities on every startup, and `ReserveSeatsInstaller` then installs the `claim_seats()` and `cancel_reservation()` functions (`CREATE OR REPLACE`). That is fine for this take-home. A production deployment would use versioned migrations instead: `synchronize` can drop and re-add a column when its type changes (losing its data), and it runs on every cold start.
>
> **Limits:** a show has at most **50,000 seats** (`MAX_SEATS_PER_SHOW` in `src/show/dto/create-show.dto.ts`). `GET /shows/:id` returns every seat, so this keeps that response around 2 MB; it also bounds what one admin request can write. Request bodies are capped at 2 MB. Seats are inserted with a single `INSERT … SELECT unnest(…)` statement, whatever the hall size.

### Tables

```sql
-- Users
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(30) UNIQUE NOT NULL,
  password_hash VARCHAR NOT NULL
);

-- Shows
CREATE TABLE shows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,                -- not unique; shows are identified by id
  price_paise BIGINT NOT NULL,
  per_user_limit INT DEFAULT 4,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Seats
CREATE TABLE seats (
  seat_id BIGSERIAL,
  show_id BIGINT REFERENCES shows(show_id) ON DELETE CASCADE,
  seat_number VARCHAR(10) NOT NULL,
  status seats_status_enum DEFAULT 'AVAILABLE',
  reserved_by BIGINT REFERENCES users(id) ON DELETE SET NULL,   -- owner while HOLD or RESERVED
  held_until TIMESTAMPTZ,                                       -- only set while HOLD
  reservation_id BIGINT REFERENCES reservations(reservation_id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (seat_id, show_id),
  UNIQUE (show_id, seat_number)
);

-- Enum
CREATE TYPE seats_status_enum AS ENUM ('AVAILABLE', 'HOLD', 'RESERVED');
```

### TypeORM Configuration

- `synchronize: true`: creates and updates tables on startup (see the note at the top of Database Design; migrations would replace it in production)
- `autoLoadEntities: true`
- PostgreSQL driver (`pg`)

---

## API Documentation (Swagger)

Access at: `http://localhost:8080/docs`

### Tags
- **Authentication** - User registration, login, admin token
- **Shows** - Show creation (admin), show retrieval (public)

### Security
- **Bearer Auth** - JWT token in Authorization header
- **Admin Key** - `x-admin-key` header for `/user/admin-token`

---

## Observability

### Health Endpoints

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /health/liveness` | Process alive check - returns 200 if process is running | None |
| `GET /health/readiness` | Traffic readiness: 200 if the database is reachable (a busy, saturated database still counts as ready, so a burst can't take the replica out of rotation); 503 if the database is unreachable or the app is shutting down. A successful check is reused for 5s. | None |

**Liveness Response (200):**
```json
{ "status": "ok", "timestamp": "2026-10-03T12:00:00.000Z" }
```

**Readiness Response (200 - DB reachable):**
```json
{ "status": "ok", "timestamp": "2026-10-03T12:00:00.000Z", "dependencies": { "database": "reachable" } }
```

**Readiness Response (200 - DB reachable but busy):**
```json
{ "status": "ok", "timestamp": "2026-10-03T12:00:00.000Z", "dependencies": { "database": "busy" } }
```

**Readiness Response (503 - DB down):**
```json
{ "statusCode": 503, "message": "Database unreachable", "error": "Service Unavailable", "timestamp": "...", "dependencies": { "database": "unreachable" } }
```

### Graceful shutdown

`app.enableShutdownHooks()` (`src/main.ts`) plus `ShutdownService` (`src/common/lifecycle/shutdown.service.ts`). On `SIGTERM`/`SIGINT`:
1. Readiness starts answering 503 (`Shutting down`), so the platform stops sending new requests.
2. Nest closes the HTTP server (in-flight requests finish) and the database pool.
3. The OpenTelemetry SDK flushes the last traces, metrics and logs.

A 25s deadline (below Azure Container Apps' 30s grace period) forces an exit if anything hangs.

### Correlation id

Every request gets an id: the caller's `x-request-id` if it's safe (`[A-Za-z0-9._-]`, up to 128 characters), otherwise a UUID (`src/common/logging/request-id.ts`, used as pino-http's `genReqId`). It is returned in the `x-request-id` response header and appears on every log line of that request as `req.id`, alongside the OpenTelemetry `trace_id`/`span_id`.

### OpenTelemetry Integration (`src/instrumentation.ts`)

- **SDK:** `@opentelemetry/sdk-node` with selective auto-instrumentations
- **Exporters (OTLP/HTTP → Traceway):**
  - Traces: `/api/otel/v1/traces`
  - Metrics: `/api/otel/v1/metrics` (10s interval). Besides the SDK's own metrics, this includes every custom Prometheus metric: `PromClientMetricProducer` (`src/metrics/prom-client-producer.ts`) is registered on the metric reader and converts the prom-client registry on each export (counters → cumulative sums, gauges → gauges, histograms → histograms). Process/Node default metrics are not bridged.
  - Logs: `/api/otel/v1/logs` (batch processor)
- **Configured instrumentations** (in `src/instrumentation.ts`):
  - `@opentelemetry/instrumentation-fs`: disabled
  - `@opentelemetry/instrumentation-net`: disabled
  - `@opentelemetry/instrumentation-dns`: disabled
  - `@opentelemetry/instrumentation-router`: disabled (due to Fastify/NestJS compatibility; enables better guard and route reporting via NestJS core instrumentation)
- **Resource attributes:** `service.name=event-booking-api`, `service.version`, `deployment.environment`
- **Log correlation:** `trace_id` and `span_id` via `instrumentation-pino`

**Note:** The `@opentelemetry/instrumentation-router` is disabled because it is designed for Express.js and does not work properly with Fastify (which NestJS uses via `@nestjs/platform-fastify`). Disabling it and relying on the NestJS core instrumentation fixes both the "Guards 401/403 not showing" and "GET /shows/:id unmatched" issues.

### Prometheus Metrics (`/metrics`)

**Endpoint:** `GET /metrics` (exposed via `@willsoto/nestjs-prometheus`)

**Default metrics (no prefix):** process CPU, memory, heap, event-loop lag, GC duration, active handles/requests.

**Custom metrics** live in `src/metrics/`. The README's "Observability" section has the full list, example queries and how the numbers reconcile.

| Where | Metrics |
|-------|---------|
| `src/metrics/metrics.module.ts` (global) | Every counter, gauge and histogram provider; names are in `metric-names.ts` |
| `src/metrics/http-metrics.ts` (Fastify hooks, registered in `main.ts`) | `http_requests_total`, `http_request_duration_seconds`, `http_requests_in_flight`, for every response, including guard (401/403) and exception-filter responses |
| `src/show/show.service.ts` | `reservations_confirmed_total`, `holds_created_total`, `reservations_declined_total{reason,action}`, `claim_seats_duration_seconds`, `claim_queue_waiting`, `claim_queue_wait_seconds`, `seat_cache_rejections_total` |
| `src/common/filters/all-exceptions.filter.ts` | `db_errors_total{reason,code}`, `unhandled_errors_total` |
| `src/metrics/seat-state-metrics.ts` (computed on scrape) | `seats_available` / `seats_held` / `seats_confirmed` / `seats_total{show_id}` from one database query (cached 1s, 50 newest shows), `db_up`, `db_pool_connections{state}` |

A failed seat-state query never fails the scrape: `db_up` drops to 0 and the last seat values are kept.

---

### Structured Logging

- **Library:** `nestjs-pino` with `pino-pretty` in development
- **Correlation:** `trace_id` and `span_id` injected via `instrumentation-pino` logHook
- **Format:** JSON (production) / Pretty (development)
- **Log levels:** Configurable via `LOG_LEVEL` env var

---

## Running the Project

### Prerequisites
- Node.js 20+
- PostgreSQL 14+
- pnpm 9+

### Installation

```bash
pnpm install
```

### Development

```bash
pnpm run start:dev    # Watch mode on port 8080
```

### Build

```bash
pnpm run build        # Outputs to dist/
```

### Production

```bash
pnpm run start:prod   # Runs dist/main.js
```

### Testing

```bash
pnpm run test         # Unit tests (vitest)
pnpm run test:e2e     # E2E tests
pnpm run test:cov     # Coverage report
```

### Linting & Formatting

```bash
pnpm run lint         # oxlint
pnpm run format       # prettier
```

---

## Security Considerations

1. **Password Hashing:** bcrypt with 10 salt rounds
2. **JWT:** HS256, 1-hour expiry, secret from env
3. **Role-Based Access:** Admin endpoints guarded by `@Roles('admin')`
4. **Input Validation:** Global ValidationPipe + custom validators
5. **SQL Injection:** TypeORM parameterized queries
6. **Admin Token:** Separate endpoint with `x-admin-key` header validation
7. **Money Safety:** Integer paise, no floating point

---

## Future Enhancements (Planned)

- [ ] Seat booking endpoints (POST `/bookings`, GET `/bookings/:id`)
- [x] Seat hold/release mechanism with TTL (`POST /shows/:id/hold`, lapses at `held_until`)
- [ ] Concurrency control (optimistic locking on seats)
- [ ] Booking history per user
- [ ] Show listing with filters (pagination, search)
- [ ] Rate limiting
- [ ] Integration tests
- [ ] Docker Compose for local dev
- [ ] CI/CD pipeline

---

## API Quick Reference

### Auth

```bash
# Register
curl -X POST http://localhost:8080/user/register \
  -H "Content-Type: application/json" \
  -d '{"username": "john_doe", "password": "securePass123"}'

# Login
curl -X POST http://localhost:8080/user/login \
  -H "Content-Type: application/json" \
  -d '{"username": "john_doe", "password": "securePass123"}'

# Admin Token
curl -X POST http://localhost:8080/user/admin-token \
  -H "x-admin-key: your-admin-secret-key"
```

### Shows

```bash
# Create Show (Admin)
curl -X POST http://localhost:8080/shows \
  -H "Authorization: Bearer <admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "friday-night",
    "seats": ["A1","A2","A3","A4","A5","B1","B2","B3","B4","B5"],
    "price_paise": 25000,
    "per_user_limit": 4
  }'

# Get Show (Public)
curl http://localhost:8080/shows/1
```

---

*Generated: October 2026*
*Project: Event Booking System*
*Version: 0.0.1*