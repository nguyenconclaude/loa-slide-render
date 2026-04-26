<template>
  <div class="foodquest-inner">
    <img v-if="$slidev.frontmatter.image" :src="$slidev.frontmatter.image" class="photo-half" />
    <div class="body">
      <div v-if="$slidev.frontmatter.eyebrow" class="small-eyebrow">
        {{ $slidev.frontmatter.eyebrow }}
      </div>
      <slot />
    </div>
  </div>
</template>
