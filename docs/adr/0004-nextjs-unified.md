# ADR: Next.js for Unified Frontend and Backend

## Context
We chose Next.js as the framework for this project to simplify development and provide a cohesive solution for both frontend and backend needs.

### 1. Unified Development Model
- Next.js allows us to build both the frontend and backend within a single application.
- This eliminates the need for separate Express and client-server setups, reducing complexity.

### 2. Simplified API Routing and Middleware
- Next.js provides built-in API routing, making it easy to define and manage backend endpoints.
- Middleware support allows for efficient handling of requests and responses.

### 3. Optimized for React
- Next.js is built on top of React, leveraging its strengths while adding features like server-side rendering (SSR) and static site generation (SSG).
- These features improve performance which are critical for modern web applications.