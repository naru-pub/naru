# The Dockerfile's two images, built in one bake so that the stages they share
# (deps) run once and the rest runs side by side: the jobs image's Chromium
# layer comes down while the web image's Next build runs. CI
# (.github/workflows/main.yml) sets the variables and pushes; locally,
#
#   docker buildx bake --load
#
# from control-plane/ builds naru-control-plane:local and
# naru-control-plane-jobs:local for scripts/smoke-test-images.sh.

variable "IMAGE" {
  default = "naru-control-plane"
}

variable "TAG" {
  default = "local"
}

variable "GIT_COMMIT" {
  default = ""
}

# Set in CI: the registry cache each image reads and writes, per architecture.
variable "CACHE_ARCH" {
  default = ""
}

group "default" {
  targets = ["web", "jobs"]
}

target "_common" {
  context = "."
  dockerfile = "Dockerfile"
  pull = true
  args = {
    GIT_COMMIT = GIT_COMMIT
  }
  labels = {
    "org.opencontainers.image.revision" = GIT_COMMIT
  }
}

target "web" {
  inherits = ["_common"]
  target = "web"
  tags = ["${IMAGE}:${TAG}"]
  cache-from = CACHE_ARCH == "" ? [] : ["type=registry,ref=${IMAGE}:build-cache-${CACHE_ARCH}"]
  cache-to = CACHE_ARCH == "" ? [] : ["type=registry,ref=${IMAGE}:build-cache-${CACHE_ARCH},mode=max"]
}

target "jobs" {
  inherits = ["_common"]
  target = "jobs"
  tags = ["${IMAGE}-jobs:${TAG}"]
  cache-from = CACHE_ARCH == "" ? [] : ["type=registry,ref=${IMAGE}-jobs:build-cache-${CACHE_ARCH}"]
  cache-to = CACHE_ARCH == "" ? [] : ["type=registry,ref=${IMAGE}-jobs:build-cache-${CACHE_ARCH},mode=max"]
}
