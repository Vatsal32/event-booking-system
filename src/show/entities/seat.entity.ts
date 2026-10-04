import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { Show } from './show.entity.js';
import type { User } from '../../user/entities/user.entity.js';
import { Reservation } from './reservation.entity.js';

/**
 * AVAILABLE -> HOLD (POST /shows/:id/hold, lapses at held_until) -> RESERVED (POST /shows/:id/reserve, permanent).
 * A HOLD whose held_until has passed counts as AVAILABLE everywhere. Nothing ever moves a seat out of RESERVED.
 */
export enum SeatStatus {
  AVAILABLE = 'AVAILABLE',
  HOLD = 'HOLD',
  RESERVED = 'RESERVED',
}

@Entity('seats')
@Index(['showId', 'seatNumber'], { unique: true })
@Index('IDX_seats_held_until_hold', ['heldUntil'], {
  where: "status = 'HOLD'",
})
@Index('IDX_seats_show_id_reserved_by', ['showId', 'reservedBy'], {
  where: 'reserved_by IS NOT NULL',
})
export class Seat {
  @PrimaryGeneratedColumn({ name: 'seat_id', type: 'bigint' })
  seatId: number;

  @PrimaryColumn({ name: 'show_id', type: 'bigint' })
  showId: string;

  @Column({ name: 'seat_number', type: 'varchar', length: 10 })
  seatNumber: string;

  @Column({
    name: 'status',
    type: 'enum',
    enum: SeatStatus,
    default: SeatStatus.AVAILABLE,
  })
  status: SeatStatus;

  @Column({ name: 'reservation_id', type: 'bigint', nullable: true })
  reservationId: string | null;

  // owner of the seat while it is HOLD or RESERVED
  @Column({ name: 'reserved_by', type: 'bigint', nullable: true })
  reservedBy: string | null;

  // only set while status = HOLD; the hold lapses (seat is free again) once this passes
  @Column({ name: 'held_until', type: 'timestamptz', nullable: true })
  heldUntil: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @ManyToOne('Show', 'seats', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'show_id' })
  show: Show;

  @ManyToOne('Reservation', 'seats', {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({ name: 'reservation_id' })
  reservation: Reservation | null;

  @ManyToOne('User', 'heldSeats', { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'reserved_by' })
  user: User | null;
}
