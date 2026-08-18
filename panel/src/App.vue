<script setup lang="ts">
import { NConfigProvider, NMessageProvider, darkTheme, type GlobalThemeOverrides } from 'naive-ui'
import HubMain from './HubMain.vue'

const themeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: '#7dd3fc',
    primaryColorHover: '#bae6fd',
    primaryColorPressed: '#38bdf8',
    bodyColor: '#0b1020',
    cardColor: '#151c31',
    modalColor: '#151c31',
    popoverColor: '#151c31',
    borderColor: '#263152',
    textColorBase: '#e8eefc'
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
