# MongoDB Migration System

Enterprise-grade MongoDB migration management system supporting multiple databases, version control, automated testing, and Kubernetes deployment.

## ✨ Key Features

- **Multi-Database Support** - Manage multiple independent MongoDB databases simultaneously.
- **Web Console** - Intuitive UI for managing migrations, validating code, and running tests.
- **Version Control** - Timestamp-based migration files for complete history tracking.
- **Safety Checks** - Prevents dangerous operations (e.g., `dropDatabase`, `createUser`) via static analysis.
- **Automated Testing** - Integrated Docker testing support for MongoDB 6.0, 7.0, and 8.0.
- **Kubernetes Ready** - Production-ready K8s manifests and deployment scripts.
- **Auto-Rollback** - Automatic recovery mechanisms for failed deployments.

## 📋 Prerequisites

- **Node.js** >= 20.0.0
- **Docker** (for local testing and Web Console)
- **Kubernetes** (for production deployment)
- **MongoDB** 6.0+

---

## 🚀 Quick Start

### 1. Installation

```bash
git clone <your-repo-url>
cd mongodb-migrate
npm install
```

### 2. Start Web Console (Recommended)

The Web Console provides a visual interface to manage your migrations.

```bash
# Start the console
npm run console
```

Open your browser at `http://localhost:8081`.

### 3. Local Development Environment

Start a local MongoDB 8.0 instance and Mongo Express for development:

```bash
docker-compose -f docker-compose.mongo.yml up -d
```
- **MongoDB**: `mongodb://127.0.0.1:27017`
- **Mongo Express**: `http://localhost:8082`

---

## 📂 Project Structure

```text
mongodb-migrate/
├── databases/               # Database configurations and migrations
│   ├── products/            # Example 'products' database
│   │   ├── config.js        # Database-specific config
│   │   └── migrations/      # Migration files (.js)
│   └── users/               # Example 'users' database
├── scripts/                 # Utility scripts
│   ├── docker-test.sh       # Integration tests
│   ├── validate-all.sh      # Batch validation
│   └── k8s-deploy.sh        # K8s deployment helper
├── src/                     # Core logic (CLI, Validators)
├── web-console/             # Web Console source code
├── k8s/                     # Kubernetes manifests
└── docker-compose.mongo.yml # Local dev environment
```

## 🛠 CLI Usage

While the Web Console is recommended, you can also use the CLI directly.

### Create a Migration
```bash
node src/cli.js create "add-user-fields" -c databases/users/config.js
```

### Validate Migrations
Check for syntax errors and forbidden operations.
```bash
node src/cli.js validate -c databases/users/config.js
```

### Run Migrations (Up)
```bash
node src/cli.js up -c databases/users/config.js
```

### Rollback (Down)
```bash
node src/cli.js down -c databases/users/config.js
```

### Check Status
```bash
node src/cli.js status -c databases/users/config.js
```

---

## 🧪 Testing

### Docker Integration Test
Runs a full cycle (Up -> Check -> Down -> Up) in an isolated container.

```bash
bash scripts/docker-test.sh
```

### Validation Check
Validates all migration files against safety rules.

```bash
bash scripts/validate-all.sh
```

## 📖 Documentation

For detailed workflow and architecture diagrams, please refer to [USAGE.md](USAGE.md).
