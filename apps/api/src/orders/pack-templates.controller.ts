import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { PackTemplatesService } from './pack-templates.service';

export class CreatePackTemplateDto {
  @IsNotEmpty({ message: '模板名必填' })
  @IsString()
  name: string;

  @IsObject({ message: '包装要求格式不正确' })
  pack: Record<string, string>;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;
}

@Controller('pack-templates')
export class PackTemplatesController {
  constructor(private readonly service: PackTemplatesService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  create(@Body() dto: CreatePackTemplateDto) {
    return this.service.create(dto);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.service.remove(id);
  }
}
