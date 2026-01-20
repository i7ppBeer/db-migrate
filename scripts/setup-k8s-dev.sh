#!/bin/bash
# ============================================================
# Kubernetes Development Environment Setup Script
# Installs: minikube, kubectl, helm, k9s
# Platforms: Linux (amd64, arm64), macOS
# ============================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Versions
MINIKUBE_VERSION="latest"
HELM_VERSION="v3.14.0"
K9S_VERSION="v0.31.7"

# Detect OS and architecture
detect_platform() {
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)
    
    case "$ARCH" in
        x86_64)
            ARCH="amd64"
            ;;
        aarch64|arm64)
            ARCH="arm64"
            ;;
        *)
            echo -e "${RED}Unsupported architecture: $ARCH${NC}"
            exit 1
            ;;
    esac
    
    echo -e "${BLUE}Detected: $OS / $ARCH${NC}"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Print section header
print_header() {
    echo -e "\n${BLUE}═══════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════${NC}\n"
}

# ============================================================
# Install kubectl
# ============================================================
install_kubectl() {
    print_header "Installing kubectl"
    
    if command_exists kubectl; then
        echo -e "${GREEN}kubectl is already installed:${NC}"
        kubectl version --client --short 2>/dev/null || kubectl version --client
        return 0
    fi
    
    echo "Downloading kubectl..."
    KUBECTL_VERSION=$(curl -L -s https://dl.k8s.io/release/stable.txt)
    
    curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/${OS}/${ARCH}/kubectl"
    chmod +x kubectl
    sudo mv kubectl /usr/local/bin/
    
    echo -e "${GREEN}kubectl installed successfully!${NC}"
    kubectl version --client
}

# ============================================================
# Install minikube
# ============================================================
install_minikube() {
    print_header "Installing minikube"
    
    if command_exists minikube; then
        echo -e "${GREEN}minikube is already installed:${NC}"
        minikube version
        return 0
    fi
    
    echo "Downloading minikube..."
    curl -LO "https://storage.googleapis.com/minikube/releases/${MINIKUBE_VERSION}/minikube-${OS}-${ARCH}"
    chmod +x "minikube-${OS}-${ARCH}"
    sudo mv "minikube-${OS}-${ARCH}" /usr/local/bin/minikube
    
    echo -e "${GREEN}minikube installed successfully!${NC}"
    minikube version
}

# ============================================================
# Install Helm
# ============================================================
install_helm() {
    print_header "Installing Helm"
    
    if command_exists helm; then
        echo -e "${GREEN}Helm is already installed:${NC}"
        helm version --short
        return 0
    fi
    
    echo "Downloading Helm ${HELM_VERSION}..."
    
    HELM_FILENAME="helm-${HELM_VERSION}-${OS}-${ARCH}.tar.gz"
    curl -LO "https://get.helm.sh/${HELM_FILENAME}"
    tar -zxvf "${HELM_FILENAME}"
    sudo mv "${OS}-${ARCH}/helm" /usr/local/bin/helm
    rm -rf "${OS}-${ARCH}" "${HELM_FILENAME}"
    
    echo -e "${GREEN}Helm installed successfully!${NC}"
    helm version --short
}

# ============================================================
# Install k9s
# ============================================================
install_k9s() {
    print_header "Installing k9s"
    
    if command_exists k9s; then
        echo -e "${GREEN}k9s is already installed:${NC}"
        k9s version --short 2>/dev/null || k9s version
        return 0
    fi
    
    echo "Downloading k9s ${K9S_VERSION}..."
    
    # k9s uses different naming convention
    K9S_OS=$OS
    K9S_ARCH=$ARCH
    
    if [ "$OS" = "darwin" ]; then
        K9S_OS="Darwin"
    elif [ "$OS" = "linux" ]; then
        K9S_OS="Linux"
    fi
    
    if [ "$ARCH" = "amd64" ]; then
        K9S_ARCH="amd64"
    elif [ "$ARCH" = "arm64" ]; then
        K9S_ARCH="arm64"
    fi
    
    K9S_FILENAME="k9s_${K9S_OS}_${K9S_ARCH}.tar.gz"
    curl -LO "https://github.com/derailed/k9s/releases/download/${K9S_VERSION}/${K9S_FILENAME}"
    tar -zxvf "${K9S_FILENAME}"
    sudo mv k9s /usr/local/bin/
    rm -f "${K9S_FILENAME}" README.md LICENSE
    
    echo -e "${GREEN}k9s installed successfully!${NC}"
    k9s version
}

# ============================================================
# Install Docker (if not present)
# ============================================================
install_docker() {
    print_header "Checking Docker"
    
    if command_exists docker; then
        echo -e "${GREEN}Docker is already installed:${NC}"
        docker --version
        return 0
    fi
    
    echo -e "${YELLOW}Docker is not installed.${NC}"
    echo "Please install Docker first:"
    echo ""
    echo "  Linux:  curl -fsSL https://get.docker.com | sh"
    echo "  macOS:  brew install --cask docker"
    echo ""
    read -p "Continue without Docker? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
}

# ============================================================
# Start minikube cluster
# ============================================================
start_minikube() {
    print_header "Starting minikube cluster"
    
    # Check if cluster already exists
    if minikube status 2>/dev/null | grep -q "Running"; then
        echo -e "${GREEN}minikube is already running${NC}"
        minikube status
        return 0
    fi
    
    echo "Starting minikube..."
    
    # Detect best driver
    DRIVER="docker"
    if ! command_exists docker; then
        if [ "$OS" = "linux" ]; then
            DRIVER="kvm2"
        elif [ "$OS" = "darwin" ]; then
            DRIVER="hyperkit"
        fi
    fi
    
    minikube start \
        --driver="$DRIVER" \
        --cpus=4 \
        --memory=8192 \
        --disk-size=40g \
        --kubernetes-version=stable \
        --addons=ingress,metrics-server,dashboard
    
    echo -e "${GREEN}minikube cluster started successfully!${NC}"
    minikube status
}

# ============================================================
# Setup Helm repos
# ============================================================
setup_helm_repos() {
    print_header "Setting up Helm repositories"
    
    # Add common repos
    helm repo add bitnami https://charts.bitnami.com/bitnami 2>/dev/null || true
    helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
    helm repo update
    
    echo -e "${GREEN}Helm repositories configured!${NC}"
    helm repo list
}

# ============================================================
# Install databases for testing
# ============================================================
install_test_databases() {
    print_header "Installing test databases"
    
    echo "Installing MongoDB..."
    helm upgrade --install mongodb bitnami/mongodb \
        --namespace databases \
        --create-namespace \
        --set auth.enabled=false \
        --set persistence.enabled=false \
        --wait --timeout=5m
    
    echo "Installing MariaDB..."
    helm upgrade --install mariadb bitnami/mariadb \
        --namespace databases \
        --set auth.rootPassword=rootpass \
        --set auth.database=migrate_test \
        --set primary.persistence.enabled=false \
        --wait --timeout=5m
    
    echo -e "${GREEN}Test databases installed!${NC}"
    
    echo -e "\n${YELLOW}Connection info:${NC}"
    echo "  MongoDB:  mongodb://mongodb.databases.svc:27017"
    echo "  MariaDB:  mariadb.databases.svc:3306 (root/rootpass)"
}

# ============================================================
# Print quick start guide
# ============================================================
print_quickstart() {
    print_header "Quick Start Guide"
    
    cat << 'EOF'
🎉 Setup Complete!

📦 Installed Tools:
  • kubectl  - Kubernetes CLI
  • minikube - Local Kubernetes cluster
  • helm     - Kubernetes package manager
  • k9s      - Terminal UI for Kubernetes

🚀 Quick Commands:

  # Start/stop cluster
  minikube start
  minikube stop

  # Open Kubernetes dashboard
  minikube dashboard

  # Open k9s terminal UI
  k9s

  # Deploy migrations (MongoDB)
  helm upgrade --install my-migrations ./charts/db-migrate \
    --set mongodb.enabled=true \
    --set mongodb.host=mongodb.databases.svc

  # Deploy migrations (MariaDB)
  helm upgrade --install my-migrations ./charts/db-migrate \
    --set mariadb.enabled=true \
    --set mariadb.host=mariadb.databases.svc \
    --set mariadb.password=rootpass

  # Check migration job status
  kubectl get jobs -w

  # View logs
  kubectl logs job/my-migrations-1

📚 Documentation:
  • minikube: https://minikube.sigs.k8s.io/docs/
  • helm:     https://helm.sh/docs/
  • k9s:      https://k9scli.io/

EOF
}

# ============================================================
# Main
# ============================================================
main() {
    echo -e "${BLUE}"
    cat << 'EOF'
╔═══════════════════════════════════════════════════════════╗
║     Kubernetes Development Environment Setup              ║
║     minikube + kubectl + helm + k9s                       ║
╚═══════════════════════════════════════════════════════════╝
EOF
    echo -e "${NC}"
    
    detect_platform
    
    # Parse arguments
    SKIP_START=false
    SKIP_DBS=false
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-start)
                SKIP_START=true
                shift
                ;;
            --skip-databases)
                SKIP_DBS=true
                shift
                ;;
            --help|-h)
                echo "Usage: $0 [options]"
                echo ""
                echo "Options:"
                echo "  --skip-start      Don't start minikube after installation"
                echo "  --skip-databases  Don't install test databases"
                echo "  --help, -h        Show this help message"
                exit 0
                ;;
            *)
                echo -e "${RED}Unknown option: $1${NC}"
                exit 1
                ;;
        esac
    done
    
    # Install tools
    install_docker
    install_kubectl
    install_minikube
    install_helm
    install_k9s
    
    # Start cluster
    if [ "$SKIP_START" = false ]; then
        start_minikube
        setup_helm_repos
        
        if [ "$SKIP_DBS" = false ]; then
            read -p "Install test databases (MongoDB, MariaDB)? (y/n) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                install_test_databases
            fi
        fi
    fi
    
    print_quickstart
}

main "$@"
