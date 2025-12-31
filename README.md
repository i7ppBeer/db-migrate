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

### 3. Build Docker Images

Build production migration runner:
```bash
docker build -t mongodb-migrate:latest .
```

Build Web Console (for development):
```bash
docker build --target console -t mongodb-migrate-console:latest .
```

### 4. Local Development Environment

Start a local MongoDB 8.0 instance and Mongo Express for development:

```bash
docker-compose -f docker-compose.mongo.yml up -d
```
- **MongoDB**: `mongodb://127.0.0.1:27017`
- **Mongo Express**: `http://localhost:8082`

### 5. Setup Minikube (Kubernetes Local Testing)

Automatically install and configure minikube with MongoDB:

```bash
./scripts/setup-minikube.sh
```

This script will:
- Install minikube, kubectl, k9s, and Helm (if not already installed)
- Start minikube cluster
- Deploy MongoDB in the `mongodb` namespace
- Create `products` and `users` databases with credentials
- Display connection credentials

Access Kubernetes dashboard:
```bash
k9s                    # Interactive terminal UI
minikube dashboard     # Web UI
```

---

## 🎯 Kubernetes Deployment

### Prerequisites

Before deploying to Kubernetes, ensure you have:
- Running Kubernetes cluster (minikube, GKE, EKS, AKS, etc.)
- kubectl configured and connected to your cluster
- Helm 3.x installed
- MongoDB instance accessible from the cluster

### Setup Kubernetes Environment (Minikube)

For local development and testing, use the automated setup script:

```bash
# Complete setup: minikube + MongoDB + databases
./scripts/setup-minikube.sh
```

The script will:
1. Install dependencies (minikube, kubectl, k9s, Helm)
2. Start minikube cluster
3. Deploy MongoDB (Bitnami chart) to `mongodb` namespace
4. Create application databases (`products`, `users`)
5. Configure database users with appropriate permissions

### Helm Chart Installation

#### 1. Build Docker Image

```bash
# Build migration runner image
docker build --target migration -t mongodb-migrate:latest .

# Load image to minikube (for local testing)
minikube image load mongodb-migrate:latest
```

#### 2. Configure Values

Edit `charts/migration-app/values.yaml` to match your environment:

```yaml
# MongoDB Configuration
mongodb:
  databases:
    - name: products
      host: mongodb.mongodb.svc.cluster.local
      port: 27017
      username: products_user
      password: products_pwd
      database: products

# Migration Configuration
mongodb-migrate:
  runMode: job              # Options: "job" or "deployment"
  dryRun: false
  dbNames:
    - products
    - users
```

**runMode Options:**
- `job` - One-time execution, good for migrations (recommended)
- `deployment` - Continuous running, good for development/debugging

#### 3. Install with Helm

First-time installation:

```bash
# Install the chart
helm install migration-app charts/migration-app/

# Check status
kubectl get jobs -n default
kubectl get pods -n default
```

#### 4. Upgrade Existing Installation

When you update migrations or configuration:

```bash
# Rebuild and reload Docker image
docker build --target migration -t mongodb-migrate:latest .
minikube image load mongodb-migrate:latest --overwrite

# Delete old job (if using runMode: job)
kubectl delete job -n default -l app.kubernetes.io/name=mongodb-migrate

# Upgrade Helm release
helm upgrade migration-app charts/migration-app/

# View logs
kubectl logs -n default $(kubectl get pods -n default -l job-name --no-headers | tail -1 | awk '{print $1}')
```

#### 5. View Migration Logs

```bash
# For Job mode
kubectl logs -n default -l app.kubernetes.io/name=mongodb-migrate

# For Deployment mode
kubectl logs -n default deployment/migration-app-mongodb-migrate

# Follow logs in real-time
kubectl logs -f -n default -l app.kubernetes.io/name=mongodb-migrate
```

#### 6. Rollback on Failure

The system includes automatic rollback functionality:
- If any migration fails, the system will automatically execute `down` migration
- Rollback logs are visible in pod logs
- Failed jobs remain for inspection (TTL: 24 hours)

To manually trigger rollback:

```bash
# Connect to pod and run down command
kubectl exec -it <pod-name> -n default -- node src/cli.js down -c databases/users/config.js
```

#### 7. Uninstall

```bash
# Remove Helm release
helm uninstall migration-app -n default

# Clean up jobs
kubectl delete jobs -n default -l app.kubernetes.io/name=mongodb-migrate

# Remove Docker image from minikube (optional)
minikube ssh "docker rmi docker.io/library/mongodb-migrate:latest"

# Or list and remove all mongodb-migrate images
minikube image ls | grep mongodb-migrate
minikube ssh "docker images | grep mongodb-migrate | awk '{print \$3}' | xargs docker rmi"
```

#### 8. Clean Up Minikube Images

When you rebuild images frequently, old images can accumulate in minikube:

```bash
# List all mongodb-migrate images in minikube
minikube image ls | grep mongodb-migrate

# Remove specific image
minikube ssh "docker rmi docker.io/library/mongodb-migrate:latest"

# Remove all unused images in minikube
minikube ssh "docker image prune -a -f"
```

### Helm Chart Configuration Reference

| Parameter | Description | Default |
|-----------|-------------|---------|
| `mongodb-migrate.runMode` | Execution mode: `job` or `deployment` | `job` |
| `mongodb-migrate.dryRun` | Preview migrations without executing | `false` |
| `mongodb-migrate.dbNames` | List of databases to migrate | `[]` |
| `mongodb-migrate.image.repository` | Docker image repository | `mongodb-migrate` |
| `mongodb-migrate.image.tag` | Docker image tag | `latest` |
| `mongodb-migrate.resources.limits.memory` | Memory limit | `512Mi` |
| `mongodb-migrate.resources.limits.cpu` | CPU limit | `200m` |

### Production Deployment Tips

1. **Use Job Mode**: For production migrations, use `runMode: job` to ensure one-time execution
2. **CI/CD Integration**: Integrate with your CI/CD pipeline to automate deployments
3. **Backup First**: Always backup your database before running migrations
4. **Test Migrations**: Test in staging environment before production
5. **Monitor Logs**: Use `kubectl logs` to monitor migration progress
6. **Version Control**: Keep migration files in version control (Git)

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
