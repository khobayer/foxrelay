Add a notices module to the NestJS API and its admin screen.

Done means:
- Prisma model Notice (id, title, body, publishedAt nullable, createdAt, updatedAt) with a migration
- CRUD endpoints under /notices with DTO validation (class-validator) and the existing permission guards
- GET /notices returns only published notices, newest first, paginated (page, limit)
- Admin screen: list, create, edit, publish/unpublish, using the existing design tokens
- Unit tests for the service and an e2e test for GET /notices
- `npx nx test api` and `npx nx build api` pass

Don't touch:
- the auth module
- existing migrations

Ask me (park a question) before adding any new npm dependency.

(Tip: for a whole project, point --goal-file at your PRD instead. The planner turns it into milestones.)
