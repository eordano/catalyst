import { ServiceFactory } from "./service/ServiceFactory";
import { ControllerFactory } from "./controller/ControllerFactory";

const DEFAULT_SERVER_PORT = 7070

export class Environment {
    private configs: Map<EnvironmentConfig, any> = new Map();
    private beans: Map<Bean,any> = new Map();

    getConfig<T>(key: EnvironmentConfig): T {
        return this.configs.get(key);
    }

    setConfig<T>(key: EnvironmentConfig, value: T): Environment {
        this.configs.set(key, value);
        return this
    }

    getBean<T>(type:Bean): T {
        return this.beans.get(type);
    }

    registerBean<T>(type: Bean, bean: T): Environment {
        this.beans.set(type, bean);
        return this
    }

    private static instance: Environment;
    static async getInstance(): Promise<Environment> {
        if(!Environment.instance) {
            // Create default instance
            Environment.instance = await new EnvironmentBuilder().build()
        }
        return Environment.instance;
    }
}

export const enum Bean {
    SERVICE,
    CONTROLLER,
}

export const enum EnvironmentConfig {
    SERVER_PORT,
    LOG_REQUESTS,
}

export class EnvironmentBuilder {
    private baseEnv: Environment
    constructor(baseEnv?:Environment) {
        this.baseEnv = baseEnv ?? new Environment()
    }

    withConfig(config: EnvironmentConfig, value: any): EnvironmentBuilder {
        this.baseEnv.setConfig(config, value)
        return this
    }

    withBean(bean: Bean, value: any): EnvironmentBuilder {
        this.baseEnv.registerBean(bean, value)
        return this
    }

    async build(): Promise<Environment> {
        const env = new Environment()

        this.registerConfigIfNotAlreadySet(env, EnvironmentConfig.SERVER_PORT               , () => process.env.SERVER_PORT         ?? DEFAULT_SERVER_PORT)
        this.registerConfigIfNotAlreadySet(env, EnvironmentConfig.LOG_REQUESTS              , () => process.env.LOG_REQUESTS !== 'false')

        // Please put special attention on the bean registration order.
        // Some beans depend on other beans, so the required beans should be registered before

        this.registerBeanIfNotAlreadySet(env, Bean.SERVICE                     , () => ServiceFactory.create(env))
        this.registerBeanIfNotAlreadySet(env, Bean.CONTROLLER                  , () => ControllerFactory.create(env))

        return env
    }

    private registerConfigIfNotAlreadySet(env: Environment, key: EnvironmentConfig, valueProvider: () => any): void {
        env.setConfig(key, this.baseEnv.getConfig(key) ?? valueProvider())
    }

    private registerBeanIfNotAlreadySet(env: Environment, key: Bean, valueProvider: ()=>any): void {
        env.registerBean(key, this.baseEnv.getBean(key) ?? valueProvider())
    }
}