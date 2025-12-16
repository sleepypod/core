# ADR: Prisma with SQLite

## Context
We chose Prisma as the ORM (Object-Relational Mapping) tool and SQLite as the database for this project to balance simplicity, developer experience, and scalability.

### 1. Prisma for ORM
- Prisma provides a modern, type-safe ORM that integrates seamlessly with TypeScript.
- It simplifies database schema management and migrations, reducing the overhead for developers.
- Prisma's query API is intuitive and aligns well with our goal of maintaining a clean and maintainable codebase.

### 2. SQLite for the Database
- SQLite is lightweight and easy to set up, making it ideal for development and small-scale production use cases.
- It eliminates the need for managing a separate database server, reducing operational complexity.
- SQLite's file-based storage is sufficient for the current scope of the project.

### 3. Future Scalability
- While SQLite is the initial choice, Prisma supports multiple databases (e.g., PostgreSQL, MySQL), allowing for easy migration if the project outgrows SQLite.
- This forward-looking approach ensures that we are not locked into a single database solution.