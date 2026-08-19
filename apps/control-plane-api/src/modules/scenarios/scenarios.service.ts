import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScenarioEntity } from './scenario.entity';
import { CreateScenarioDto, UpdateScenarioDto } from './scenario.dto';
import { ScenarioStatus } from '@apilens/shared-types';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class ScenariosService {
  constructor(
    @InjectRepository(ScenarioEntity)
    private scenariosRepository: Repository<ScenarioEntity>,
    private auditService: AuditService,
  ) {}

  async findAll(skip: number, take: number, status?: ScenarioStatus, tag?: string) {
    const query = this.scenariosRepository.createQueryBuilder('scenario')
      .skip(skip)
      .take(take)
      .orderBy('scenario.updatedAt', 'DESC');

    if (status) {
      query.andWhere('scenario.status = :status', { status });
    }
    
    if (tag) {
      query.andWhere(':tag = ANY(scenario.tags)', { tag });
    }

    const [data, total] = await query.getManyAndCount();
    return { data, total };
  }

  async findOne(id: string) {
    const scenario = await this.scenariosRepository.findOne({ where: { id } });
    if (!scenario) throw new NotFoundException('Scenario not found');
    return scenario;
  }

  async create(dto: CreateScenarioDto, userId: string) {
    const scenario = this.scenariosRepository.create({
      ...dto,
      createdBy: userId,
      version: 1,
      status: 'draft',
    });
    
    const saved = await this.scenariosRepository.save(scenario);
    await this.auditService.log(userId, 'scenario.created', 'Scenario', saved.id, { name: saved.name });
    
    return saved;
  }

  async update(id: string, dto: UpdateScenarioDto, userId: string) {
    const scenario = await this.findOne(id);
    
    Object.assign(scenario, dto);
    scenario.version += 1;
    
    const saved = await this.scenariosRepository.save(scenario);
    await this.auditService.log(userId, 'scenario.updated', 'Scenario', saved.id, { version: saved.version });
    
    return saved;
  }

  async softDelete(id: string, userId: string) {
    const scenario = await this.findOne(id);
    scenario.status = 'archived';
    const saved = await this.scenariosRepository.save(scenario);
    
    await this.auditService.log(userId, 'scenario.deleted', 'Scenario', saved.id, {});
    return saved;
  }

  async setStatus(id: string, status: ScenarioStatus, userId: string) {
    const scenario = await this.findOne(id);
    scenario.status = status;
    const saved = await this.scenariosRepository.save(scenario);
    
    await this.auditService.log(userId, `scenario.status_changed`, 'Scenario', saved.id, { status });
    return saved;
  }

  async exportAsPlaywright(id: string): Promise<string> {
    const scenario = await this.findOne(id);
    
    let code = `// Playwright Route Mocks for Scenario: ${scenario.name}\n`;
    code += `// Description: ${scenario.description}\n\n`;
    code += `import { Page } from '@playwright/test';\n\n`;
    code += `export async function setupMocks(page: Page) {\n`;

    for (const rule of scenario.rules) {
      if (rule.condition.urlPattern) {
        code += `  await page.route('${rule.condition.urlPattern}', async route => {\n`;
        
        if (rule.action.type === 'mock_response') {
          code += `    await route.fulfill({\n`;
          code += `      status: ${rule.action.statusCode || 200},\n`;
          if (rule.action.headers) {
            code += `      headers: ${JSON.stringify(rule.action.headers)},\n`;
          }
          if (rule.action.body) {
            code += `      body: JSON.stringify(${JSON.stringify(rule.action.body)}),\n`;
          }
          code += `    });\n`;
        } else if (rule.action.type === 'simulate_error') {
          code += `    await route.abort('${rule.action.errorType === 'network_error' ? 'failed' : 'aborted'}');\n`;
        } else if (rule.action.type === 'delay') {
          code += `    await new Promise(resolve => setTimeout(resolve, ${rule.action.delayMs || 1000}));\n`;
          code += `    await route.continue();\n`;
        }
        
        code += `  });\n\n`;
      }
    }

    code += `}\n`;
    return code;
  }
}
