import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
	base: './',
	root: 'src',
	plugins: [
		viteSingleFile()
	],
	build: {
		target: 'esnext',
		cssCodeSplit: false,
		outDir: '../dist',
		emptyOutDir: true,
		minify: false
	}
});