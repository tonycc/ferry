import { ref } from "vue";
import { api, type Me } from "./api";

/** 当前登录的人;App.vue 启动时读一次 */
export const me = ref<Me>();

export async function loadMe(): Promise<void> {
  me.value = await api.get<Me>("/api/me");
}
