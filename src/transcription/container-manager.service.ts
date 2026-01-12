import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DockerModule = require('dockerode');

@Injectable()
export class ContainerManagerService {
  private readonly logger = new Logger(ContainerManagerService.name);
  private docker: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  private readonly containerName = 'whisper-worker';

  constructor() {
    // Connect to Docker daemon
    // If running in Docker, use the socket; otherwise try default socket
    const DockerClass = DockerModule.default || DockerModule;
    this.docker = new DockerClass({
      socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    });
  }

  async ensureContainerRunning(): Promise<void> {
    try {
      const container = this.docker.getContainer(this.containerName);
      
      try {
        const inspect = await container.inspect();
        
        if (!inspect.State.Running) {
          this.logger.log(`Container ${this.containerName} is not running. Starting...`);
          await container.start();
          this.logger.log(`Container ${this.containerName} start command sent, waiting for readiness...`);
          
          // Wait for container to be ready (health check)
          await this.waitForContainerReady(container, 180); // 3 minutes max wait (model loading takes time)
          this.logger.log(`Container ${this.containerName} started and ready`);
        } else {
          this.logger.debug(`Container ${this.containerName} is already running`);
          // Even if running, verify it's actually responding
          // Use a shorter timeout and don't fail if it times out - container is running
          try {
            await this.waitForContainerReady(container, 15); // Quick check with shorter timeout
          } catch (error: any) {
            // If health check times out but container is running, log warning and continue
            // The container might be busy processing a request
            this.logger.warn(
              `Health check timeout for ${this.containerName}, but container is running. Proceeding anyway.`,
            );
          }
        }
      } catch (error: any) {
        if (error.statusCode === 404) {
          // Container doesn't exist - try to create it via docker-compose
          this.logger.warn(`Container ${this.containerName} not found. Attempting to start via docker-compose...`);
          try {
            const { execSync } = require('child_process');
            // whisper-worker is now a shared service - start it from shared directory
            execSync(`cd /root/shared/whisper-worker && docker-compose up -d whisper-worker`, {
              stdio: 'pipe',
              timeout: 30000,
            });
            this.logger.log('Container created and started via docker-compose');
            // Wait a bit for container to start
            await new Promise((resolve) => setTimeout(resolve, 10000));
            // Get the container reference again
            const newContainer = this.docker.getContainer(this.containerName);
            // Wait for it to be ready
            await this.waitForContainerReady(newContainer, 180);
            this.logger.log(`Container ${this.containerName} is ready`);
            return;
          } catch (composeError: any) {
            this.logger.error(`Failed to create container: ${composeError.message}`);
            throw new Error(
              `Container ${this.containerName} not found. Please start it manually: docker-compose up -d whisper-worker`,
            );
          }
        }
        throw error;
      }
    } catch (error: any) {
      this.logger.error(`Failed to manage container: ${error.message}`);
      throw new ServiceUnavailableException(
        `Failed to start whisper-worker container: ${error.message}. Please ensure the container can be started.`,
      );
    }
  }

  private async waitForContainerReady(
    container: any, // eslint-disable-line @typescript-eslint/no-explicit-any
    maxWaitSeconds: number,
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 5000; // Check every 5 seconds
    const whisperServiceUrl = process.env.WHISPER_SERVICE_URL || 'http://whisper-worker:8000';
    let lastError: any = null;
    
    this.logger.log(`Waiting up to ${maxWaitSeconds}s for container to be ready...`);
    
    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      try {
        const inspect = await container.inspect();
        
        if (!inspect.State.Running) {
          this.logger.warn(`Container ${this.containerName} is not running (status: ${inspect.State.Status})`);
          if (inspect.State.ExitCode !== 0) {
            throw new Error(`Container exited with code ${inspect.State.ExitCode}`);
          }
          // Container stopped, try to start it again
          await container.start();
          continue;
        }
        
        // Try to hit the health endpoint
        try {
          const axios = require('axios');
          const response = await axios.get(`${whisperServiceUrl}/health`, {
            timeout: 10000,
            validateStatus: () => true, // Accept any status
          });
          
          if (response.status === 200 && response.data?.status === 'ok' && response.data?.model_loaded) {
            this.logger.log('Container is ready and responding to health checks');
            return;
          } else {
            lastError = new Error(`Health check returned status ${response.status}, model_loaded: ${response.data?.model_loaded}`);
          }
        } catch (healthError: any) {
          lastError = healthError;
          if (healthError.code === 'ECONNREFUSED' || healthError.code === 'EAI_AGAIN') {
            this.logger.debug(`Health check failed (${healthError.code}): Container might still be loading model...`);
          } else {
            this.logger.debug(`Health check attempt failed: ${healthError.message}`);
          }
        }
      } catch (error: any) {
        lastError = error;
        this.logger.debug(`Waiting for container to be ready... (${error.message})`);
      }
      
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      this.logger.debug(`Still waiting... (${elapsed}s/${maxWaitSeconds}s)`);
      await new Promise((resolve) => setTimeout(resolve, checkInterval));
    }
    
    const errorMsg = lastError 
      ? `Container did not become ready within ${maxWaitSeconds}s. Last error: ${lastError.message || lastError.code}`
      : `Container did not become ready within ${maxWaitSeconds}s`;
    
    this.logger.error(errorMsg);
    throw new ServiceUnavailableException(errorMsg);
  }
}

