<template>
  <div class="foodquest-cover">
    <img v-if="$slidev.frontmatter.image" :src="$slidev.frontmatter.image" class="photo" />
    <div class="gradient-bottom"></div>
    <div class="text-block">
      <div v-if="$slidev.frontmatter.eyebrow" class="eyebrow">
        {{ $slidev.frontmatter.eyebrow }}
      </div>
      <div class="hook">
        <slot />
      </div>
      <div class="accent-line"></div>
      <div v-if="$slidev.frontmatter.tagline" class="tagline">
        {{ $slidev.frontmatter.tagline }}
      </div>
    </div>
  </div>
</template>
