# MongoDB Migration Workflow

## 🔄 Workflow Diagram

> If the Mermaid diagram below does not render, please refer to the text version at the bottom.

```mermaid
flowchart TD
    subgraph Development ["💻 Local Development"]
        A["Start"] --> B{"New Migration?"}
        B -- Yes --> C["npm run create <br/> -c projects/xxx/config.js"]
        C --> D["Edit Migration File"]
        D --> E["npm run validate"]
        E --> F["bash scripts/docker-test.sh <br/> (Docker Test)"]
        F -- Fail --> D
        F -- Pass --> G["Commit & Push"]
        B -- No --> G
    end

    subgraph CI_CD ["⚙️ CI/CD Pipeline"]
        G --> H["Build Docker Image"]
        H --> I["Push to Registry"]
    end

    subgraph Deployment ["🚀 Kubernetes Deployment"]
        I --> J["Apply ConfigMap & Secret"]
        J --> K["kubectl apply -f <br/> k8s/migration-job.yaml"]
        
        K --> L["Pod Start: <br/> migration-runner"]
        
        L --> M{"SKIP_TESTS?"}
        M -- False --> N["Embedded MongoDB Test <br/> (6.0, 7.0, 8.0)"]
        N -- Fail --> O["Job Failed <br/> (Safe, Prod untouched)"]
        N -- Pass --> P["Connect to Prod DB"]
        M -- True --> P
        
        P --> Q["Execute Migration Up"]
        Q -- Fail --> R["Auto Rollback"]
        Q -- Success --> S["Job Completed"]
    end

    style Development fill:#e1f5fe,stroke:#01579b
    style CI_CD fill:#fff3e0,stroke:#ff6f00
    style Deployment fill:#e8f5e9,stroke:#2e7d32
```

### 📄 Text Version

```text
+-----------------------------------------------------------------------+
|                        💻 Local Development                            |
+-----------------------------------------------------------------------+
|                                                                       |
|  [Start] --> <New Migration?> -- Yes --> [npm run create]             |
|                  |                          |                         |
|                  No                         v                         |
|                  |                  [Edit Migration File]             |
|                  |                          |                         |
|                  |                          v                         |
|                  |                  [npm run validate]                |
|                  |                          |                         |
|                  |                          v                         |
|                  |               [bash scripts/docker-test.sh]        |
|                  |                     (Docker Test)                  |
|                  |                          |                         |
|                  |        (Fail) <----------+----------> (Pass)       |
|                  |          |                               |         |
|                  v          +-------------------------------+         |
|            [Commit & Push] <--------------------------------+         |
|                  |                                                    |
+------------------+----------------------------------------------------+
                   |
                   v
+-----------------------------------------------------------------------+
|                        ⚙️ CI/CD Pipeline                               |
+-----------------------------------------------------------------------+
|                  |                                                    |
|                  v                                                    |
|         [Build Docker Image] --> [Push to Registry]                   |
|                                       |                               |
+---------------------------------------+-------------------------------+
                                        |
                                        v
+-----------------------------------------------------------------------+
|                        🚀 Kubernetes Deployment                        |
+-----------------------------------------------------------------------+
|                                       |                               |
|    [Apply ConfigMap & Secret] <-------+                               |
|              |                                                        |
|              v                                                        |
|    [kubectl apply -f k8s/migration-job.yaml]                          |
|              |                                                        |
|              v                                                        |
|    [Pod Start: migration-runner]                                      |
|              |                                                        |
|              v                                                        |
|        <SKIP_TESTS?> -- False --> [Embedded MongoDB Test]             |
|              |                        (6.0, 7.0, 8.0)                 |
|              |                               |                        |
|              True                     (Fail) | (Pass)                 |
|              |                          |    |                        |
|              |                          v    v                        |
|              +-------------------> [Connect to Prod DB]               |
|                                         |                             |
|                                         v                             |
|                                 [Execute Migration Up]                |
|                                         |                             |
|                                (Fail) <-+-> (Success)                 |
|                                  |            |                       |
|                                  v            v                       |
|                           [Auto Rollback]   [Job Completed]           |
|                                                                       |
+-----------------------------------------------------------------------+
```

## 📝 Common Commands

### 1. Initialize & Create
```bash
# Create a new migration file
node src/cli.js create "add-user-fields" -c databases/users/config.js
```

### 2. Validate & Test
```bash
# Validate migration syntax and rules
npm run validate

# Run full Docker integration test (includes 6.0 -> 8.0 upgrade & rollback)
bash scripts/docker-test.sh
```

### 3. Manual Execution (Local)
```bash
# Run migration for a specific project
node src/cli.js up -c databases/orders/config.js

# Check status
node src/cli.js status -c databases/orders/config.js

# Rollback
node src/cli.js down -c databases/orders/config.js
```

### 4. Kubernetes Deployment
```bash
# Deploy Migration Job
kubectl apply -f k8s/migration-job.yaml

# Check logs
kubectl logs -f job/mongodb-migration -n mongodb-migrations
```
