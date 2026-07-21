import { ApiProperty } from '@nestjs/swagger';

export class MessageStatusTotalsDto {
  @ApiProperty() sent: number;
  @ApiProperty() delivered: number;
  @ApiProperty() read: number;
  @ApiProperty() failed: number;
  @ApiProperty() total: number;
}

export class MessageDailyPointDto {
  @ApiProperty({ example: '2026-07-20' })
  date: string;

  @ApiProperty() delivered: number;
  @ApiProperty() failed: number;
}

export class MessageAnalyticsDto {
  @ApiProperty({ description: 'Number of days covered', example: 14 })
  rangeDays: number;

  @ApiProperty({ type: MessageStatusTotalsDto })
  totals: MessageStatusTotalsDto;

  @ApiProperty({ description: 'delivered ÷ total, 0–1', example: 0.987 })
  deliveryRate: number;

  @ApiProperty({ description: 'read ÷ delivered, 0–1', example: 0.762 })
  readRate: number;

  @ApiProperty({ type: [MessageDailyPointDto], description: 'Daily delivered vs. failed' })
  series: MessageDailyPointDto[];
}
