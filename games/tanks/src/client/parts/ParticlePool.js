import { Sprite } from 'pixi.js';

const pool = [];

export default {
  get(texture) {
    if (pool.length > 0) {
      const sprite = pool.pop();
      sprite.texture = texture;
      // Сброс базовых параметров, чтобы не наследовать состояние с прошлой жизни
      sprite.alpha = 1;
      sprite.scale.set(1);
      sprite.rotation = 0;
      sprite.tint = 0xffffff;
      sprite.anchor.set(0.5);
      sprite.visible = true;
      return sprite;
    }
    return new Sprite(texture);
  },

  release(sprite) {
    if (!sprite) {
      return;
    }

    // Удаляем со сцены, чтобы он не рисовался, пока лежит в пуле
    if (sprite.parent) {
      sprite.parent.removeChild(sprite);
    }

    // Очищаем customData, если есть ссылки, чтобы не держать память
    if (sprite.customData) {
      sprite.customData = null;
    }

    pool.push(sprite);
  },
};
