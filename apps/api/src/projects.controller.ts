import { Body, Controller, Get, Param, Post, Sse } from '@nestjs/common';
import { ProjectsService } from './projects.service.js';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.projects.create(body);
  }

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(':id')
  find(@Param('id') id: string) {
    return this.projects.find(id);
  }

  @Sse(':id/snapshots')
  snapshots(@Param('id') id: string) {
    return this.projects.snapshots(id);
  }

  @Post(':id/review')
  async review(@Param('id') id: string, @Body() body: unknown) {
    await this.projects.review(id, body);
    return { accepted: true };
  }

  @Post(':id/questions/:questionId/answer')
  async answerQuestion(
    @Param('id') id: string,
    @Param('questionId') questionId: string,
    @Body() body: unknown,
  ) {
    await this.projects.answerQuestion(id, questionId, body);
    return { accepted: true };
  }

  @Post(':id/agents/:role/comments')
  async commentOnAgent(
    @Param('id') id: string,
    @Param('role') role: string,
    @Body() body: unknown,
  ) {
    await this.projects.commentOnAgent(id, role, body);
    return { accepted: true };
  }

  @Post(':id/artifacts/:artifactId/feedback')
  async commentOnArtifact(
    @Param('id') id: string,
    @Param('artifactId') artifactId: string,
    @Body() body: unknown,
  ) {
    await this.projects.commentOnArtifact(id, artifactId, body);
    return { accepted: true };
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string) {
    await this.projects.resume(id);
    return { accepted: true };
  }
}
