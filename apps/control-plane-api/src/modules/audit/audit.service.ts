import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogEntity } from './audit-log.entity';

@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLogEntity)
    private auditRepository: Repository<AuditLogEntity>,
  ) {}

  async log(
    userId: string,
    action: string,
    resourceType: string,
    resourceId: string,
    details: Record<string, any> = {},
    ipAddress: string | null = null,
  ) {
    const entry = this.auditRepository.create({
      userId,
      action,
      resourceType,
      resourceId,
      details,
      ipAddress,
    });
    return this.auditRepository.save(entry);
  }

  async findByUser(userId: string, pagination: { skip: number; take: number }) {
    return this.auditRepository.findAndCount({
      where: { userId },
      order: { timestamp: 'DESC' },
      skip: pagination.skip,
      take: pagination.take,
    });
  }

  async findByResource(resourceType: string, resourceId: string, pagination: { skip: number; take: number }) {
    return this.auditRepository.findAndCount({
      where: { resourceType, resourceId },
      order: { timestamp: 'DESC' },
      skip: pagination.skip,
      take: pagination.take,
    });
  }

  async findAll(pagination: { skip: number; take: number }) {
    return this.auditRepository.findAndCount({
      order: { timestamp: 'DESC' },
      skip: pagination.skip,
      take: pagination.take,
    });
  }
}
