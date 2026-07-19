# PATH

One maintenance note: the warmed store is a snapshot of today's lockfile. If agents add dependencies, pnpm install in the sandbox will download just the new packages — still fine. But if the lockfile drifts a lot over time, rebuild the image (pnpm exec sandcastle docker build-image --dockerfile .sandcastle/Dockerfile) to re-warm it.