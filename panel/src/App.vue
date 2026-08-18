<script setup lang="ts">
import { NConfigProvider, NMessageProvider, darkTheme, type GlobalThemeOverrides } from 'naive-ui'
import HubMain from './HubMain.vue'

const themeOverrides: GlobalThemeOverrides = {
  common: {
    fontFamily: '"Segoe UI Variable Text", "SF Pro Text", "PingFang SC", "Microsoft YaHei", sans-serif',
    primaryColor: '#8b7cff',
    primaryColorHover: '#a89bff',
    primaryColorPressed: '#6f5dff',
    bodyColor: '#09090b',
    cardColor: '#121216',
    modalColor: '#121216',
    popoverColor: '#16161c',
    borderColor: 'rgba(255,255,255,0.08)',
    textColorBase: '#f4f4f5',
    borderRadius: '12px'
  }
}
</script>

<template>
  <n-config-provider :theme="darkTheme" :theme-overrides="themeOverrides">
    <n-message-provider>
      <HubMain />
    </n-message-provider>
  </n-config-provider>
</template>
