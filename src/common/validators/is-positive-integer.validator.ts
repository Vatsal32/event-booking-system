import { ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments } from 'class-validator';

@ValidatorConstraint({ name: 'isPositiveInteger', async: false })
export class IsPositiveIntegerConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
  }

  defaultMessage(args: ValidationArguments) {
    return `${args.property} must be a positive integer`;
  }
}