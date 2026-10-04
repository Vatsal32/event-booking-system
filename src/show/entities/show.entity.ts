import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Seat } from './seat.entity.js';
import { Reservation } from './reservation.entity.js';

@Entity('shows')
export class Show {
  @PrimaryGeneratedColumn({ name: 'show_id', type: 'bigint' })
  showId: number;

  // not unique: shows are identified by show_id, and re-running a script with the same name must work
  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ name: 'price_paise', type: 'bigint' })
  pricePaise: number;

  @Column({ name: 'per_user_limit', type: 'int', default: 4 })
  perUserLimit: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => Seat, (child) => child.show, { cascade: true })
  seats: Seat[];

  @OneToMany(() => Reservation, (reservation) => reservation.show)
  reservations: Reservation[];
}