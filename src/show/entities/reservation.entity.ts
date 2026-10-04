import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { Seat } from './seat.entity.js';
import type { Show } from './show.entity.js';

@Entity({ name: 'reservations' })
@Index('idx_expires_at', ['expiresAt'])
@Index('idx_user_id', ['userId'])
// exactly-once per (user, key); also makes the idempotency lookup an index read
@Index('uq_reservations_user_idem', ['userId', 'idempotencyKey'], {
  unique: true,
})
export class Reservation {
  @PrimaryGeneratedColumn({
    name: 'reservation_id',
    type: 'bigint',
  })
  reservationId: string;

  @Column({
    name: 'show_id',
    type: 'bigint',
  })
  showId: string;

  @Column({
    name: 'user_id',
    type: 'varchar',
    length: 50,
  })
  userId: string;

  @Column({
    name: 'idempotency_key',
    type: 'varchar',
    length: 100,
  })
  idempotencyKey: string;

  // The columns below are written by claim_seats() and replayed on a retry with the same key.
  // Nullable only so `synchronize` can add them to tables that already have rows.

  // sha256 of "showId:sortedSeats", to reject the same key sent with a different body
  @Column({ name: 'request_hash', type: 'text', nullable: true })
  requestHash: string | null;

  @Column({ name: 'seat_numbers', type: 'text', array: true, nullable: true })
  seatNumbers: string[] | null;

  @Column({ name: 'amount_paise', type: 'bigint', nullable: true })
  amountPaise: string | null;

  // which endpoint created this record: POST /shows/:id/hold or POST /shows/:id/reserve
  @Column({ name: 'kind', type: 'varchar', length: 10, default: 'RESERVE' })
  kind: 'HOLD' | 'RESERVE';

  // when the hold lapses; NULL for a reservation, which never expires
  @Column({
    name: 'expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  expiresAt: Date | null;

  // set when the owner cancels it (POST /reservations/:id/cancel); its seats are then released
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  createdAt: Date;

  @OneToMany('Seat', 'reservation', { cascade: true })
  seats: Seat[];

  @ManyToOne('Seat', {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'seat_id' })
  seat: Seat;

  @ManyToOne('Show', 'reservations', {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'show_id' })
  show: Show;
}
