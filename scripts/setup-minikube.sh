#!/bin/bash

set -e

echo "=== Setting up Minikube Kubernetes Environment ==="

# Check if minikube is installed
if ! command -v minikube &> /dev/null; then
    echo "Installing minikube..."
    curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
    sudo install minikube-linux-amd64 /usr/local/bin/minikube
    rm minikube-linux-amd64
    echo "✓ Minikube installed"
else
    echo "✓ Minikube already installed"
fi

# Check if kubectl is installed
if ! command -v kubectl &> /dev/null; then
    echo "Installing kubectl..."
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
    sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
    rm kubectl
    echo "✓ kubectl installed"
else
    echo "✓ kubectl already installed"
fi

# Check if k9s is installed
if ! command -v k9s &> /dev/null; then
    echo "Installing k9s..."
    curl -sS https://webinstall.dev/k9s | bash
    export PATH="$HOME/.local/bin:$PATH"
    echo "✓ k9s installed"
else
    echo "✓ k9s already installed"
fi

# Check if helm is installed
if ! command -v helm &> /dev/null; then
    echo "Installing helm..."
    curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
    echo "✓ Helm installed"
else
    echo "✓ Helm already installed"
fi

# Check if minikube is already running
if minikube status &> /dev/null; then
    echo "✓ Minikube is already running"
else
    echo "Starting minikube..."
    minikube start --driver=docker
    echo "✓ Minikube started"
fi

# Wait for cluster to be ready
echo "Waiting for cluster to be ready..."
kubectl wait --for=condition=Ready nodes --all --timeout=300s

# Install MongoDB
echo ""
echo "=== Installing MongoDB ==="

# Create mongodb namespace
if ! kubectl get namespace mongodb &> /dev/null; then
    kubectl create namespace mongodb
    echo "✓ Created namespace: mongodb"
else
    echo "✓ Namespace mongodb already exists"
fi

# Add Bitnami Helm repository
if ! helm repo list 2>/dev/null | grep -q bitnami; then
    helm repo add bitnami https://charts.bitnami.com/bitnami
    echo "✓ Added Bitnami Helm repository"
else
    echo "✓ Bitnami Helm repository already added"
fi

helm repo update

# Install MongoDB using Helm
if ! helm list -n mongodb | grep -q mongodb; then
    echo "Installing MongoDB..."
    helm install mongodb bitnami/mongodb \
        --namespace mongodb \
        --set auth.rootPassword=rootpassword \
        --set auth.username=mongouser \
        --set auth.password=mongopassword \
        --set auth.database=admin \
        --set architecture=standalone \
        --set persistence.enabled=false
    echo "✓ MongoDB installed"
else
    echo "MongoDB release exists, checking pods..."
    if ! kubectl get pods -n mongodb -l app.kubernetes.io/name=mongodb &> /dev/null || [ $(kubectl get pods -n mongodb -l app.kubernetes.io/name=mongodb --no-headers 2>/dev/null | wc -l) -eq 0 ]; then
        echo "No pods found, reinstalling MongoDB..."
        helm uninstall mongodb -n mongodb
        helm install mongodb bitnami/mongodb \
            --namespace mongodb \
            --set auth.rootPassword=rootpassword \
            --set auth.username=mongouser \
            --set auth.password=mongopassword \
            --set auth.database=admin \
            --set architecture=standalone \
            --set persistence.enabled=false
        echo "✓ MongoDB reinstalled"
    else
        echo "✓ MongoDB already installed"
    fi
fi

# Wait for MongoDB to be ready
echo "Waiting for MongoDB to be ready..."
if kubectl wait --for=condition=Ready pod -l app.kubernetes.io/name=mongodb -n mongodb --timeout=300s 2>/dev/null; then
    echo "✓ MongoDB is ready!"
else
    echo "Warning: Timeout waiting for MongoDB, but continuing..."
fi


echo ""
echo "=== Creating Databases and Users ==="

# Get MongoDB pod name
MONGO_POD=$(kubectl get pod -n mongodb -l app.kubernetes.io/name=mongodb -o jsonpath='{.items[0].metadata.name}')

# Create products database and user
echo "Creating products db and user..."
kubectl exec -n mongodb $MONGO_POD -c mongodb -- mongosh admin \
  --username root \
  --password rootpassword \
  --eval "
    db = db.getSiblingDB('products');
    db.createUser({
      user: 'products_user',
      pwd: 'products_pwd',
      roles: [
        { role: 'readWrite', db: 'products' },
        { role: 'dbAdmin', db: 'products' }
      ]
    });
    print('✓ products db created');
  "

# Create users database and user
echo "Creating users db and user..."
kubectl exec -n mongodb $MONGO_POD -- mongosh admin \
  --username root \
  --password rootpassword \
  --eval "
    db = db.getSiblingDB('users');
    db.createUser({
      user: 'users_user',
      pwd: 'users_pwd',
      roles: [
        { role: 'readWrite', db: 'users' },
        { role: 'dbAdmin', db: 'users' }
      ]
    });
    db.users.insertOne({ _id: 1, username: 'admin', created: new Date() });
    print('✓ users created');
  "

echo "✓ Databases and users created successfully!"
echo ""
echo "Database Credentials:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "products:"
echo "  Username: products_user"
echo "  Password: products_pwd"
echo "  Connection: mongodb://products_user:products_pwd@mongodb.mongodb.svc.cluster.local:27017/products"
echo ""
echo "users:"
echo "  Username: users_user"
echo "  Password: users_pwd"
echo "  Connection: mongodb://users_user:users_pwd@mongodb.mongodb.svc.cluster.local:27017/users"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "MongoDB Connection Info:"
echo "  Host: mongodb.mongodb.svc.cluster.local"
echo "  Port: 27017"
echo "  Root Password: rootpassword"
echo "  Username: mongouser"
echo "  Password: mongopassword"
echo "  Connection String: mongodb://mongouser:mongopassword@mongodb.mongodb.svc.cluster.local:27017/admin"

# Display cluster info
echo ""
echo "=== Cluster Information ==="
kubectl cluster-info
echo ""
echo "=== Nodes ==="
kubectl get nodes
echo ""
echo "✓ Minikube environment is ready!"
echo ""
echo "Useful commands:"
echo "  - kubectl get pods --all-namespaces"
echo "  - kubectl get pods -n mongodb (check MongoDB)"
echo "  - k9s (interactive Kubernetes dashboard)"
echo "  - helm list -n mongodb (list MongoDB release)"
echo "  - minikube dashboard"
echo "  - minikube stop"
echo "  - minikube delete"
